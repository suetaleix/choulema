from concurrent.futures import ThreadPoolExecutor
import time

from fastapi.testclient import TestClient

import db
import server
import v6_commerce as commerce
import v6_engine as engine
import v6_payments as payments


def _user(phone, name, admin=False):
    assert db.create_user(phone, name, "test-password")[0]
    uid = db.authenticate(phone, "test-password")["id"]
    if admin:
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?", (uid,))
    return uid


def test_cards_separate_features_extend_and_redeem_once():
    uid = _user("10000000061", "member61")
    admin = _user("10000000062", "admin62", True)
    first = commerce.generate_cards("pro", 30, 1, "月卡", "体验", None, admin, payments.CATALOG)["codes"][0]
    second = commerce.generate_cards("pro", 90, 1, "季卡", "续期", None, admin, payments.CATALOG)["codes"][0]
    skin = commerce.generate_cards("cosmic", 365, 1, "皮肤年卡", "赠送", None, admin, payments.CATALOG)["codes"][0]
    before = int(time.time())
    a = commerce.redeem_card(first, uid)
    b = commerce.redeem_card(second, uid)
    assert before + 120 * 86400 <= b["expires_at"] <= before + 120 * 86400 + 2
    assert commerce.redeem_card(first, uid)["already_redeemed"] is True
    assert set(engine.features(f"user:{uid}")) == {"pro"}
    commerce.redeem_card(skin, uid)
    assert set(engine.features(f"user:{uid}")) == {"pro", "cosmic"}
    details = commerce.entitlement_details(f"user:{uid}")
    assert {r["source_kind"] for r in details["sources"]} == {"card"}
    assert details["features"]["pro"]["expires_at"] == b["expires_at"]
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_entitlements").fetchone()[0] == 3


def test_concurrent_redeem_can_only_grant_once():
    one = _user("10000000063", "member63")
    two = _user("10000000064", "member64")
    admin = _user("10000000065", "admin65", True)
    code = commerce.generate_cards("pro", 30, 1, "并发测试", "验收", None, admin, payments.CATALOG)["codes"][0]
    def attempt(uid):
        try:
            return commerce.redeem_card(code, uid)
        except ValueError as exc:
            return str(exc)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, (one, two)))
    assert sum(isinstance(result, dict) for result in results) == 1
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_entitlements").fetchone()[0] == 1


def test_expired_void_and_disabled_cards_do_not_grant():
    user = _user("10000000066", "member66")
    admin = _user("10000000067", "admin67", True)
    result = commerce.generate_cards("pro", 30, 1, "待作废", "验收", None, admin, payments.CATALOG)
    card_id = commerce.list_batch_cards(result["batch_id"])[0]["id"]
    assert commerce.void_card(card_id, admin, "发错批次")
    try:
        commerce.redeem_card(result["codes"][0], user)
        assert False
    except ValueError as exc:
        assert "作废" in str(exc)
    code = commerce.generate_cards("cosmic", 30, 1, "停用账号", "验收", None, admin, payments.CATALOG)["codes"][0]
    assert db.set_user_status(user, "disabled", actor_id=admin)
    try:
        commerce.redeem_card(code, user)
        assert False
    except ValueError as exc:
        assert "账号" in str(exc)
    assert not engine.features(f"user:{user}")


def test_expired_card_is_distinct_from_unused_card():
    user = _user("10000000070", "member70")
    admin = _user("10000000071", "admin71", True)
    result = commerce.generate_cards("pro", 30, 1, "过期检查", "验收", int(time.time()) + 86400, admin, payments.CATALOG)
    with db.conn() as c:
        c.execute("UPDATE v6_card_batches SET redeem_deadline=? WHERE id=?", (int(time.time()) - 1, result["batch_id"]))
    assert commerce.list_card_batches()[0]["expired"] == 1
    assert commerce.list_batch_cards(result["batch_id"])[0]["state"] == "expired"
    try:
        commerce.redeem_card(result["codes"][0], user)
        assert False
    except ValueError as exc:
        assert "截止" in str(exc)


def test_admin_routes_price_version_and_card_code_redaction():
    admin = _user("10000000068", "admin68", True)
    _user("10000000069", "member69")
    with TestClient(server.app) as client, TestClient(server.app) as regular:
        assert client.post("/api/login", json={"phone": "10000000068", "password": "test-password"}).status_code == 200
        assert regular.post("/api/login", json={"phone": "10000000069", "password": "test-password"}).status_code == 200
        assert regular.get("/api/v6/admin/products").status_code == 403
        assert regular.post("/api/v6/admin/card-batches", json={"feature": "pro", "days": 30, "quantity": 1, "label": "无权"}).status_code == 403
        product = client.post("/api/v6/admin/products/cosmic", json={"price_cents": 1290, "sale_visible": False, "reason": "首发价格调整"})
        assert product.status_code == 200
        assert product.json()["price_version"] == 2
        item = next(p for p in client.get("/api/v6/admin/products").json()["products"] if p["slug"] == "cosmic")
        assert item["price_cents"] == 1290 and not item["sale_visible"] and not item["sale_enabled"]
        versions = client.get("/api/v6/admin/products/cosmic/history").json()["versions"]
        assert [(v["version"], v["price_cents"]) for v in versions] == [(2, 1290), (1, 990)]
        batch = client.post("/api/v6/admin/card-batches", json={"feature": "cosmic", "days": 90, "quantity": 2, "label": "秋季活动", "purpose": "赠送"})
        assert batch.status_code == 200
        code = batch.json()["codes"][0]
        batch_id = batch.json()["batch_id"]
        assert code.startswith("CLM-")
        assert code not in str(client.get("/api/v6/admin/card-batches").json())
        assert code not in str(client.get(f"/api/v6/admin/card-batches/{batch_id}/cards").json())
        assert regular.post("/api/v6/cards/redeem", json={"code": code}).status_code == 200
        assert regular.get("/api/v6/account").json()["features"]["cosmic"]["source_kind"] == "card"
        assert regular.post("/api/v6/cards/redeem", json={"code": code}).json()["already_redeemed"]
        with db.conn() as c:
            audit = c.execute("SELECT action FROM admin_audit WHERE actor_id=? ORDER BY id", (admin,)).fetchall()
        assert [row["action"] for row in audit] == ["product_change", "card_batch_generate_export"]
