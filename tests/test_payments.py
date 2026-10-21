import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi.testclient import TestClient

import db
import server
import v6_engine as engine
import v6_payments as pay
import v6_commerce as commerce


@pytest.fixture
def merchant(tmp_path, monkeypatch):
    merchant_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    alipay_private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    merchant_file = tmp_path / "merchant.pem"
    public_file = tmp_path / "alipay-public.pem"
    merchant_file.write_bytes(merchant_private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    public_file.write_bytes(alipay_private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    for key, value in {"V6_SALES_ENABLED": "1", "ALIPAY_APP_ID": "test-app", "ALIPAY_SELLER_ID": "2088000000000000",
                       "ALIPAY_PRIVATE_KEY_FILE": str(merchant_file), "ALIPAY_PUBLIC_KEY_FILE": str(public_file),
                       "LOTTERY_PUBLIC_URL": "https://lottery.example.test",
                       "ALIPAY_GATEWAY": "https://openapi-sandbox.dl.alipaydev.com/gateway.do"}.items():
        monkeypatch.setenv(key, value)
    return {"merchant_private": merchant_private, "alipay_private": alipay_private}


def _sign(payload: bytes, private):
    return base64.b64encode(private.sign(payload, padding.PKCS1v15(), hashes.SHA256())).decode()


def notification(order, private, **overrides):
    data = {"out_trade_no": order["order_no"], "trade_no": "trade-" + order["order_no"],
            "app_id": "test-app", "seller_id": "2088000000000000", "total_amount": f"{order['amount']/100:.2f}",
            "trade_status": "TRADE_SUCCESS", "sign_type": "RSA2", "charset": "utf-8"}
    data.update(overrides)
    data["sign"] = _sign(pay._canonical(data, exclude=("sign", "sign_type")).encode(), private)
    return data


def test_sales_closed_by_default():
    assert not any(item["sale_enabled"] for item in pay.catalog("guest:1"))
    with pytest.raises(engine.DomainError):
        pay.checkout("user:1", "cosmic", "closed-request")


def test_legacy_store_has_no_live_checkout_and_old_endpoints_remain_retired():
    legacy = (Path(__file__).resolve().parents[1] / "static" / "legacy.html").read_text(encoding="utf-8")
    assert "/api/saas/buy" not in legacy
    assert "旧版商品已停售" in legacy and "已购买的历史内容仍可使用" in legacy
    with TestClient(server.app) as client:
        assert client.post("/api/saas/buy").status_code == 410
        assert client.post("/api/saas/notify").status_code == 410


def test_existing_order_table_adds_refund_columns_without_losing_rows():
    with db.conn() as c:
        c.execute("DROP TABLE v6_orders")
        c.execute("""CREATE TABLE v6_orders(order_no TEXT PRIMARY KEY, owner TEXT NOT NULL,
            request_id TEXT NOT NULL, snapshot TEXT NOT NULL, amount INTEGER NOT NULL,
            state TEXT NOT NULL, pay_order_id TEXT, pay_data TEXT, created_at INTEGER NOT NULL,
            paid_at INTEGER, query_at INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,request_id))""")
        c.execute("INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,created_at) VALUES(?,?,?,?,?,'paid',?)",
                  ("OLDPAID", "user:1", "old-paid", json.dumps({"slug": "pro", "name": "专业", "provider": "alipay"}), 9900, 123))
    pay.init_schema()
    pay.init_schema()
    with db.conn() as c:
        row = c.execute("SELECT amount,state,refund_cents,refund_state FROM v6_orders WHERE order_no='OLDPAID'").fetchone()
    assert tuple(row) == (9900, "paid", 0, "")
    assert pay.admin_orders()["orders"][0]["issues"] == ["missing_grant"]


def test_confirmed_catalog_and_merchant_setup(merchant, monkeypatch):
    products = {item["slug"]: item for item in pay.catalog("guest:annual")}
    assert (products["cosmic"]["price_cents"], products["pro"]["price_cents"]) == (990, 9900)
    assert all(item["days"] == 365 and item["sale_enabled"] for item in products.values())
    monkeypatch.setenv("ALIPAY_SELLER_ID", "")
    assert not pay.enabled()


@pytest.mark.parametrize("channel,method,code", [("pc", "alipay.trade.page.pay", "FAST_INSTANT_TRADE_PAY"),
                                              ("mobile", "alipay.trade.wap.pay", "QUICK_WAP_PAY")])
def test_checkout_url_signature_and_price_snapshot(merchant, channel, method, code):
    db.set_setting("v6_price_cosmic", "690")
    created = pay.checkout("user:1", "cosmic", "checkout-123", channel)
    params = {key: values[0] for key, values in parse_qs(urlparse(created["pay_data"]["payData"]).query).items()}
    assert params["method"] == method
    assert json.loads(params["biz_content"])["product_code"] == code
    assert params["return_url"].endswith("order=" + created["order_no"])
    merchant["merchant_private"].public_key().verify(base64.b64decode(params["sign"]), pay._canonical(params).encode(), padding.PKCS1v15(), hashes.SHA256())
    db.set_setting("v6_price_cosmic", "990")
    assert pay.order("user:1", created["order_no"])["amount"] == 690
    assert pay.checkout("user:1", "cosmic", "checkout-123", channel)["order_no"] == created["order_no"]
    assert pay.checkout("user:1", "cosmic", "different-request", channel)["order_no"] == created["order_no"]


def test_new_checkout_requires_visible_price_version_after_admin_reprices(merchant):
    assert db.create_user("10000000984", "price984", "test-password")[0]
    uid = db.authenticate("10000000984", "test-password")["id"]
    old = next(item for item in pay.catalog(f"user:{uid}") if item["slug"] == "cosmic")
    commerce.set_product("cosmic", 1290, True, uid, "价格调整测试", pay.CATALOG)
    with pytest.raises(engine.DomainError) as error:
        pay.checkout(f"user:{uid}", "cosmic", "fresh-checkout", expected_version=old["price_version"])
    assert error.value.status == 409
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_orders").fetchone()[0] == 0
    fresh = next(item for item in pay.catalog(f"user:{uid}") if item["slug"] == "cosmic")
    order = pay.checkout(f"user:{uid}", "cosmic", "fresh-checkout", expected_version=fresh["price_version"])
    assert order["amount"] == 1290


def test_signed_notification_grants_once_and_rejects_mismatch(merchant):
    created = pay.checkout("user:1", "cosmic", "notify-123")
    bad = notification(created, merchant["alipay_private"], total_amount="0.01")
    pay.verify_notification(bad)
    with pytest.raises(engine.DomainError):
        pay.settle(bad)
    assert not engine.features("user:1")
    data = notification(created, merchant["alipay_private"])
    changed = dict(data, trade_status="TRADE_CLOSED")
    with pytest.raises(engine.DomainError):
        pay.verify_notification(changed)
    pay.verify_notification(data)
    for _ in range(3):
        pay.settle(data)
    assert pay.order("user:1", created["order_no"])["state"] == "paid"
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_entitlements").fetchone()[0] == 1


def test_callback_route_rejects_duplicate_fields_and_returns_plain_success(merchant):
    created = pay.checkout("user:1", "pro", "notify-route")
    data = notification(created, merchant["alipay_private"])
    with TestClient(server.app) as client:
        assert client.post("/api/v6/payment/notify", json=data).status_code == 400
        duplicated = urlencode(list(data.items()) + [("total_amount", "0.01")])
        assert client.post("/api/v6/payment/notify", content=duplicated, headers={"Content-Type": "application/x-www-form-urlencoded"}).status_code == 400
        response = client.post("/api/v6/payment/notify", data=data)
        assert response.text == "success" and response.headers["content-type"].startswith("text/plain")
        assert client.post("/api/v6/payment/notify", data=data).text == "success"


def test_grant_and_payment_are_atomic(merchant):
    created = pay.checkout("user:1", "cosmic", "atomic-123")
    data = notification(created, merchant["alipay_private"])
    with db.conn() as c:
        c.execute("CREATE TRIGGER fail_grant BEFORE INSERT ON v6_entitlements BEGIN SELECT RAISE(ABORT, 'test interruption'); END")
    with pytest.raises(Exception, match="test interruption"):
        pay.settle(data)
    assert pay.order("user:1", created["order_no"])["state"] == "pending"
    with db.conn() as c:
        c.execute("DROP TRIGGER fail_grant")
    pay.settle(data)
    assert pay.order("user:1", created["order_no"])["state"] == "paid"


def test_signed_query_recovers_missed_callback(merchant, monkeypatch):
    created = pay.checkout("user:1", "cosmic", "query-123")
    payload = {"code": "10000", "msg": "Success", "out_trade_no": created["order_no"],
               "trade_no": "trade-" + created["order_no"], "total_amount": "9.90", "trade_status": "TRADE_SUCCESS"}
    raw_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    raw = '{"alipay_trade_query_response":' + raw_payload + ',"sign":"' + _sign(raw_payload.encode(), merchant["alipay_private"]) + '"}'
    calls = []
    def fake_post(url, data, timeout):
        calls.append(data)
        return httpx.Response(200, text=raw, request=httpx.Request("POST", url))
    monkeypatch.setattr(pay.httpx, "post", fake_post)
    monkeypatch.setenv("V6_SALES_ENABLED", "0")
    assert pay.refresh("user:1", created["order_no"])["state"] == "paid"
    assert len(calls) == 1 and calls[0]["method"] == "alipay.trade.query"
    assert pay.refresh("user:1", created["order_no"])["state"] == "paid"


def test_verified_recheck_repairs_missing_paid_grant_once_without_extending_again(merchant, monkeypatch):
    first = pay.checkout("user:1", "cosmic", "repair-first")
    pay.settle(notification(first, merchant["alipay_private"]))
    second = pay.checkout("user:1", "cosmic", "repair-second")
    pay.settle(notification(second, merchant["alipay_private"]))
    with db.conn() as c:
        expected = c.execute("SELECT expires_at FROM v6_entitlements WHERE source=?", (second["order_no"],)).fetchone()[0]
        c.execute("DELETE FROM v6_entitlements WHERE source=?", (first["order_no"],))
    assert pay.admin_issue_counts()["missing_grant"] == 1
    flagged = pay.admin_orders(issue="missing_grant")
    assert flagged["total"] == 1 and flagged["orders"][0]["issues"] == ["missing_grant"]
    payload = {"code": "10000", "out_trade_no": first["order_no"],
               "trade_no": "trade-" + first["order_no"], "total_amount": "9.90", "trade_status": "TRADE_SUCCESS"}
    raw_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    raw = '{"alipay_trade_query_response":' + raw_payload + ',"sign":"' + _sign(raw_payload.encode(), merchant["alipay_private"]) + '"}'
    monkeypatch.setattr(pay.httpx, "post", lambda url, data, timeout: httpx.Response(200, text=raw, request=httpx.Request("POST", url)))
    assert pay.refresh("user:1", first["order_no"])["state"] == "paid"
    assert pay.admin_issue_counts()["missing_grant"] == 0
    assert pay.refresh("user:1", first["order_no"])["state"] == "paid"
    with db.conn() as c:
        repaired = c.execute("SELECT expires_at FROM v6_entitlements WHERE source=?", (first["order_no"],)).fetchone()[0]
        later = c.execute("SELECT expires_at FROM v6_entitlements WHERE source=?", (second["order_no"],)).fetchone()[0]
        events = c.execute("SELECT COUNT(*) FROM v6_payment_events WHERE order_no=? AND event='grant_repaired'", (first["order_no"],)).fetchone()[0]
    assert repaired < later == expected and events == 1


def test_verified_recheck_never_revives_revoked_paid_source(merchant, monkeypatch):
    created = pay.checkout("user:1", "cosmic", "revoked-source")
    pay.settle(notification(created, merchant["alipay_private"]))
    with db.conn() as c:
        c.execute("INSERT INTO v6_entitlement_revocations(owner,feature,source,reason,created_at) VALUES(?,?,?,?,?)",
                  ("user:1", "cosmic", created["order_no"], "manual_review", int(time.time())))
    assert pay.admin_issue_counts()["revoked_grant"] == 1
    assert pay.admin_orders(issue="revoked_grant")["orders"][0]["issues"] == ["revoked_grant"]
    payload = {"code": "10000", "out_trade_no": created["order_no"],
               "trade_no": "trade-" + created["order_no"], "total_amount": "9.90", "trade_status": "TRADE_SUCCESS"}
    raw_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    raw = '{"alipay_trade_query_response":' + raw_payload + ',"sign":"' + _sign(raw_payload.encode(), merchant["alipay_private"]) + '"}'
    monkeypatch.setattr(pay.httpx, "post", lambda url, data, timeout: httpx.Response(200, text=raw, request=httpx.Request("POST", url)))
    with pytest.raises(engine.DomainError) as error:
        pay.refresh("user:1", created["order_no"])
    assert error.value.status == 409
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_payment_events WHERE event='grant_repaired'").fetchone()[0] == 0


def test_full_refund_revokes_only_its_source_and_rebases_later_card(merchant):
    assert db.create_user("10000000981", "refund981", "test-password")[0]
    uid = db.authenticate("10000000981", "test-password")["id"]
    owner = f"user:{uid}"
    first = pay.checkout(owner, "cosmic", "refund-first")
    pay.settle(notification(first, merchant["alipay_private"]))
    skin = commerce.generate_cards("cosmic", 30, 1, "退款后的卡", "测试", None, uid, pay.CATALOG)["codes"][0]
    card = commerce.redeem_card(skin, uid)
    other = pay.checkout(owner, "pro", "unrelated-feature")
    pay.settle(notification(other, merchant["alipay_private"]))
    assert card["expires_at"] > int(time.time()) + 360 * 86400
    closed = notification(first, merchant["alipay_private"], trade_status="TRADE_CLOSED")
    pay.verify_notification(closed)
    pay.settle(closed)
    pay.settle(closed)
    assert pay.order(owner, first["order_no"])["state"] == "refunded"
    details = commerce.entitlement_details(owner)
    revoked = next(x for x in details["sources"] if x["source"] == first["order_no"])
    assert revoked["revoked"] and not revoked["active"]
    assert int(time.time()) + 29 * 86400 < details["features"]["cosmic"]["expires_at"] < int(time.time()) + 31 * 86400
    assert {"cosmic", "pro"} <= engine.features(owner)
    metrics = commerce.admin_overview()
    assert metrics["alipay_paid_orders"] == 2
    assert metrics["alipay_refund_cents"] == first["amount"]
    assert metrics["alipay_net_cents"] == other["amount"]
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_payment_events WHERE order_no=? AND event='full_refund'", (first["order_no"],)).fetchone()[0] == 1


def test_partial_refund_stays_under_review_and_full_refund_is_atomic(merchant):
    created = pay.checkout("user:1", "cosmic", "refund-partial")
    pay.settle(notification(created, merchant["alipay_private"]))
    partial = notification(created, merchant["alipay_private"], refund_fee="2.00")
    pay.verify_notification(partial)
    pay.settle(partial)
    pay.settle(partial)
    current = pay.order("user:1", created["order_no"])
    assert current["state"] == "paid" and current["refund_state"] == "partial_review" and current["refund_cents"] == 200
    assert pay.admin_issue_counts()["refund_review"] == 1
    assert "cosmic" in engine.features("user:1")
    with pytest.raises(engine.DomainError):
        pay.settle(notification(created, merchant["alipay_private"], refund_fee="20.00"))
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_payment_events WHERE order_no=? AND event='refund_review'", (created["order_no"],)).fetchone()[0] == 1
        c.execute("""CREATE TRIGGER fail_revoke BEFORE INSERT ON v6_entitlement_revocations
            BEGIN SELECT RAISE(ABORT, 'revocation interrupted'); END""")
    with pytest.raises(Exception, match="revocation interrupted"):
        pay.settle(notification(created, merchant["alipay_private"], trade_status="TRADE_CLOSED"))
    assert pay.order("user:1", created["order_no"])["state"] == "paid"
    with db.conn() as c:
        c.execute("DROP TRIGGER fail_revoke")
    pay.settle(notification(created, merchant["alipay_private"], trade_status="TRADE_CLOSED"))
    assert pay.order("user:1", created["order_no"])["state"] == "refunded"
    assert "cosmic" not in engine.features("user:1")


def test_admin_reconcile_queries_signed_full_refund_after_payment(merchant, monkeypatch):
    assert db.create_user("10000000982", "admin982", "test-password")[0]
    admin_uid = db.authenticate("10000000982", "test-password")["id"]
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE id=?", (admin_uid,))
    assert db.create_user("10000000983", "buyer983", "test-password")[0]
    buyer_uid = db.authenticate("10000000983", "test-password")["id"]
    created = pay.checkout(f"user:{buyer_uid}", "cosmic", "refund-reconcile")
    pay.settle(notification(created, merchant["alipay_private"]))
    payload = {"code": "10000", "msg": "Success", "out_trade_no": created["order_no"],
               "trade_no": "trade-" + created["order_no"], "total_amount": "9.90", "trade_status": "TRADE_CLOSED"}
    raw_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    raw = '{"alipay_trade_query_response":' + raw_payload + ',"sign":"' + _sign(raw_payload.encode(), merchant["alipay_private"]) + '"}'
    monkeypatch.setattr(pay.httpx, "post", lambda url, data, timeout: httpx.Response(200, text=raw, request=httpx.Request("POST", url)))
    with TestClient(server.app, base_url="https://lottery.example.test") as admin, TestClient(server.app, base_url="https://lottery.example.test") as buyer:
        assert admin.post("/api/login", json={"phone": "10000000982", "password": "test-password"}).status_code == 200
        assert buyer.post("/api/login", json={"phone": "10000000983", "password": "test-password"}).status_code == 200
        assert db.get_user(admin_uid)["role"] == "superadmin"
        assert admin.get("/api/v6/admin/overview").status_code == 200, admin.get("/api/me").text
        route = f"/api/v6/admin/orders/{created['order_no']}/reconcile"
        assert buyer.post(route).status_code == 403
        reconciled = admin.post(route)
        assert reconciled.status_code == 200, reconciled.text
        assert reconciled.json()["state"] == "refunded"
        assert buyer.get(f"/api/v6/orders/{created['order_no']}").json()["state"] == "refunded"
    assert "cosmic" not in engine.features(f"user:{buyer_uid}")


def test_query_failure_preserves_order_and_legacy_orders_are_readable(merchant, monkeypatch):
    created = pay.checkout("user:1", "cosmic", "query-timeout")
    def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("test")
    monkeypatch.setattr(pay.httpx, "post", timeout)
    with pytest.raises(engine.DomainError) as error:
        pay.refresh("user:1", created["order_no"])
    assert error.value.status == 502 and pay.order("user:1", created["order_no"])["state"] == "pending"
    old = {"slug": "pro", "name": "专业功能版", "feature": "pro", "days": 365, "mch": "old", "app": "old"}
    with db.conn() as c:
        c.execute("INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,pay_data,created_at) VALUES(?,?,?,?,?,?,?,?)",
                  ("V6HISTORICAL", "user:1", "old-request", json.dumps(old), 9900, "pending", json.dumps({"payData": "https://old.invalid"}), int(time.time())))
    assert pay.order("user:1", "V6HISTORICAL")["state"] == "legacy_unavailable"
    assert pay.order("user:1", "V6HISTORICAL")["pay_data"] == {}
    assert pay.refresh("user:1", "V6HISTORICAL")["state"] == "legacy_unavailable"


def test_admin_order_search_covers_all_pages_filters_and_historical_rows():
    with db.conn() as c:
        for index in range(25):
            direct = index < 20
            snapshot = {"slug": "cosmic" if index % 2 else "pro", "name": "星空" if index % 2 else "专业",
                        "feature": "cosmic" if index % 2 else "pro", "days": 365,
                        "provider": "alipay" if direct else "historical",
                        "channel": "pc" if direct and index % 2 else "mobile" if direct else "legacy"}
            c.execute("""INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,
                pay_order_id,created_at,refund_cents,refund_state) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                (f"ORDER{index:02d}", f"user:{index}", f"request-{index}", json.dumps(snapshot),
                 990 if index % 2 else 9900, "paid" if direct else "pending",
                 f"trade-{index:02d}" if direct else None, 1000 + index,
                 200 if index == 15 else 0, "partial_review" if index == 15 else ""))
    first = pay.admin_orders(page_size=10)
    assert (first["total"], first["pages"], first["page"]) == (25, 3, 1)
    assert [item["order_no"] for item in first["orders"]] == [f"ORDER{i:02d}" for i in range(24, 14, -1)]
    assert len(pay.admin_orders(page=3, page_size=10)["orders"]) == 5
    assert pay.admin_orders(page=100, page_size=10)["page"] == 3
    assert pay.admin_orders(q="trade-15")["orders"][0]["order_no"] == "ORDER15"
    assert pay.admin_orders(q="%")['total'] == 0
    assert pay.admin_orders(slug="cosmic", provider="alipay", channel="pc")["total"] == 10
    assert pay.admin_orders(provider="historical")["total"] == 5
    assert pay.admin_orders(state="legacy_unavailable")["total"] == 5
    assert pay.admin_orders(state="pending")["total"] == 0
    assert pay.admin_orders(state="partial_review")["orders"][0]["refund_cents"] == 200
    assert pay.admin_orders(from_ts=1010, to_ts=1015)["total"] == 6
    with pytest.raises(engine.DomainError):
        pay.admin_orders(page_size=1000)
    with pytest.raises(engine.DomainError):
        pay.admin_orders(from_ts=1015, to_ts=1010)


def test_admin_order_route_requires_superadmin_and_validates_filters():
    assert db.create_user("10000000891", "orderadmin", "test-password")[0]
    assert db.create_user("10000000892", "orderbuyer", "test-password")[0]
    admin_uid = db.authenticate("10000000891", "test-password")["id"]
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE id=?", (admin_uid,))
    with TestClient(server.app) as admin, TestClient(server.app) as buyer:
        assert admin.post("/api/login", json={"phone": "10000000891", "password": "test-password"}).status_code == 200
        assert buyer.post("/api/login", json={"phone": "10000000892", "password": "test-password"}).status_code == 200
        assert buyer.get("/api/v6/admin/orders").status_code == 403
        response = admin.get("/api/v6/admin/orders?page=1&page_size=20")
        assert response.status_code == 200 and response.json()["total"] == 0
        assert admin.get("/api/v6/admin/orders?provider=unknown").status_code == 400


def test_concurrent_checkout_one_order(merchant):
    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(lambda _: pay.checkout("user:1", "pro", "concurrent-123"), range(5)))
    assert len({item["order_no"] for item in results}) == 1


def test_legacy_paid_pack_survives_product_deactivation():
    product = db.get_product("template_festival")
    number = db.create_order("user", 1, product["price_cents"], product_id=product["id"])
    with db.conn() as c:
        c.execute("UPDATE products SET active=0 WHERE id=?", (product["id"],))
    assert db.mark_order_paid(number, "historical-trade")["status"] == "paid"
    assert db.mark_order_paid(number, "historical-trade")["status"] == "paid"
    assert db.has_purchase("user", 1, product["id"])
    assert not db.is_member("user", 1)
