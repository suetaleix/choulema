"""Direct Alipay RSA2 website payments. Sales are closed without merchant setup."""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urlencode, urlparse

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

import db
import v6_commerce as commerce
import v7_catalog as content_catalog
from v6_engine import DomainError, encoded, features


CATALOG = content_catalog.PRODUCTS
GATEWAYS = {"https://openapi.alipay.com/gateway.do", "https://openapi-sandbox.dl.alipaydev.com/gateway.do"}


def init_schema():
    with db.conn() as c:
        c.executescript("""CREATE TABLE IF NOT EXISTS v6_orders(
            order_no TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL,
            snapshot TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL,
            pay_order_id TEXT, pay_data TEXT, created_at INTEGER NOT NULL, paid_at INTEGER,
            query_at INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,request_id));
        CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_gateway_id ON v6_orders(pay_order_id) WHERE pay_order_id IS NOT NULL;""")
        columns = {row["name"] for row in c.execute("PRAGMA table_info(v6_orders)")}
        for name, ddl in {
            "refund_cents": "INTEGER NOT NULL DEFAULT 0",
            "refund_state": "TEXT NOT NULL DEFAULT ''",
            "refunded_at": "INTEGER",
            "reconciled_at": "INTEGER",
        }.items():
            if name not in columns:
                c.execute(f"ALTER TABLE v6_orders ADD COLUMN {name} {ddl}")
        c.execute("""CREATE TABLE IF NOT EXISTS v6_payment_events(
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL,
            event TEXT NOT NULL, trade_no TEXT NOT NULL, amount_cents INTEGER NOT NULL,
            created_at INTEGER NOT NULL)""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_v6_payment_events_order ON v6_payment_events(order_no,id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_v6_orders_created ON v6_orders(created_at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_v6_orders_owner_created ON v6_orders(owner,created_at DESC)")
        c.execute("""CREATE TABLE IF NOT EXISTS v6_refund_requests(
            order_no TEXT PRIMARY KEY, request_no TEXT NOT NULL UNIQUE,
            amount_cents INTEGER NOT NULL, reason TEXT NOT NULL, actor_id INTEGER NOT NULL,
            state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '', lease_token TEXT NOT NULL DEFAULT '',
            lease_until INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""")
    commerce.init_schema(CATALOG)


def settings():
    return {"app_id": os.getenv("ALIPAY_APP_ID", "").strip(),
            "seller_id": os.getenv("ALIPAY_SELLER_ID", "").strip(),
            "private_file": os.getenv("ALIPAY_PRIVATE_KEY_FILE", "").strip(),
            "public_file": os.getenv("ALIPAY_PUBLIC_KEY_FILE", "").strip(),
            "public": os.getenv("LOTTERY_PUBLIC_URL", "").rstrip("/"),
            "gateway": os.getenv("ALIPAY_GATEWAY", "https://openapi.alipay.com/gateway.do").rstrip("/")}


def _private_key(cfg):
    with open(cfg["private_file"], "rb") as handle:
        return serialization.load_pem_private_key(handle.read(), password=None)


def _public_key(cfg):
    with open(cfg["public_file"], "rb") as handle:
        return serialization.load_pem_public_key(handle.read())


def configured():
    cfg = settings()
    if not all(cfg[k] for k in ("app_id", "seller_id", "private_file", "public_file", "public")):
        return False
    callback = urlparse(cfg["public"])
    if cfg["gateway"] not in GATEWAYS or callback.scheme != "https" or not callback.hostname or callback.username or callback.password or callback.path not in ("", "/") or callback.query or callback.fragment:
        return False
    try:
        private = _private_key(cfg)
        public = _public_key(cfg)
    except (ValueError, TypeError, OSError):
        return False
    return isinstance(private, rsa.RSAPrivateKey) and isinstance(public, rsa.RSAPublicKey)


def enabled():
    from v7_operations import sales_allowed
    return os.getenv("V6_SALES_ENABLED") == "1" and configured() and sales_allowed()


def catalog(owner):
    owned = features(owner)
    items = []
    with db.conn() as c:
        for slug, product in CATALOG.items():
            state = commerce.product_state(slug, product["price_cents"])
            items.append({"slug": slug, **product, **state, **commerce.product_metadata(c,slug,product), "owned": product["feature"] in owned,
                          "sale_enabled": bool(state["price_cents"] and state["sale_visible"] and content_catalog.product_available(product) and enabled())})
    return sorted(items,key=lambda p:(p['sort_order'],p['slug']))


def _canonical(params, exclude=("sign",)):
    return "&".join(f"{key}={params[key]}" for key in sorted(params) if key not in exclude and params[key] not in (None, ""))


def _sign(params, cfg):
    value = _private_key(cfg).sign(_canonical(params).encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    return base64.b64encode(value).decode("ascii")


def _verify(message: bytes, signature: str, cfg):
    try:
        _public_key(cfg).verify(base64.b64decode(signature, validate=True), message, padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, ValueError, OSError) as exc:
        raise DomainError("支付宝签名校验失败", 400) from exc


def _common(method: str, biz: dict, cfg: dict, *, order_no: str | None = None):
    params = {"app_id": cfg["app_id"], "method": method, "format": "JSON", "charset": "utf-8", "sign_type": "RSA2",
              "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "version": "1.0",
              "biz_content": json.dumps(biz, ensure_ascii=False, separators=(",", ":"))}
    if order_no:
        params["notify_url"] = cfg["public"] + "/api/v6/payment/notify"
        params["return_url"] = cfg["public"] + "/payment-return.html?order=" + order_no
    params["sign"] = _sign(params, cfg)
    return params


def _checkout_url(number: str, snapshot: dict, amount: int, cfg: dict):
    mobile = snapshot["channel"] == "mobile"
    biz = {"out_trade_no": number, "total_amount": f"{amount/100:.2f}",
           "subject": "抽了马 " + snapshot["name"], "body": snapshot["description"],
           "product_code": "QUICK_WAP_PAY" if mobile else "FAST_INSTANT_TRADE_PAY",
           "timeout_express": "30m", "seller_id": cfg["seller_id"]}
    if mobile:
        biz["quit_url"] = cfg["public"] + "/payment-return.html?order=" + number
    method = "alipay.trade.wap.pay" if mobile else "alipay.trade.page.pay"
    return cfg["gateway"] + "?" + urlencode(_common(method, biz, cfg, order_no=number))


def _gateway_post(method: str, biz: dict, cfg: dict):
    params = _common(method, biz, cfg)
    # Alipay selects POST decoding and response signing charset from the URL.
    # Keeping charset only in the form makes real responses default to GBK.
    query = urlencode({"charset": params.pop("charset")})
    return httpx.post(cfg["gateway"] + "?" + query, data=params, timeout=15)


def public_order(row):
    snapshot = json.loads(row["snapshot"])
    legacy = snapshot.get("provider") != "alipay"
    return {"order_no": row["order_no"], "name": snapshot["name"], "slug": snapshot["slug"], "amount": row["amount"],
            "state": "legacy_unavailable" if legacy and row["state"] != "paid" else row["state"],
            "created_at": row["created_at"], "paid_at": row["paid_at"], "channel": snapshot.get("channel", "legacy"),
            "refund_cents": row["refund_cents"], "refund_state": row["refund_state"],
            "refunded_at": row["refunded_at"], "reconciled_at": row["reconciled_at"],
            "pay_data": {} if legacy else json.loads(row["pay_data"] or "{}")}


def _grant_state(c, row, feature):
    """The source row, rather than a user's other grants, proves this order applied."""
    revoked = c.execute("""SELECT 1 FROM v6_entitlement_revocations
        WHERE owner=? AND feature=? AND source=?""", (row["owner"], feature, row["order_no"])).fetchone()
    if revoked:
        return "revoked"
    grant = c.execute("""SELECT 1 FROM v6_entitlements
        WHERE owner=? AND feature=? AND source=?""", (row["owner"], feature, row["order_no"])).fetchone()
    return "applied" if grant else "missing"


def order(owner, number):
    with db.conn() as c:
        row = c.execute("SELECT * FROM v6_orders WHERE order_no=? AND owner=?", (number, owner)).fetchone()
    if not row:
        raise DomainError("订单不存在", 404)
    return public_order(row)


def list_orders(owner):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM v6_orders WHERE owner=? ORDER BY created_at DESC,rowid DESC LIMIT 50", (owner,)).fetchall()
    return [public_order(row) for row in rows]


def checkout(owner, slug, request_id, channel="pc", expected_version=None):
    if not owner.startswith("user:"):
        raise DomainError("请先免费注册或登录，当前配置会保留", 401)
    if channel not in ("pc", "mobile"):
        raise DomainError("支付设备类型无效", 400)
    with db.conn() as c:
        previous = c.execute("SELECT * FROM v6_orders WHERE owner=? AND request_id=?", (owner, request_id)).fetchone()
    if previous:
        if json.loads(previous["snapshot"])["slug"] != slug:
            raise DomainError("重试订单不能更换商品", 409)
        return public_order(previous)
    product = next((item for item in catalog(owner) if item["slug"] == slug), None)
    if not product:
        raise DomainError("商品不存在", 404)
    if not product["sale_enabled"]:
        raise DomainError("商品定价或支付通道尚未开放，可先免费体验", 503)
    cfg = settings()
    number = "CLM" + time.strftime("%y%m%d%H%M%S") + secrets.token_hex(5).upper()
    snapshot = {**CATALOG[slug], "slug": slug, "provider": "alipay", "app_id": cfg["app_id"],
                "seller_id": cfg["seller_id"], "channel": channel,
                "price_version": product["price_version"], "price_cents": product["price_cents"]}
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        existing = c.execute("SELECT * FROM v6_orders WHERE owner=? AND request_id=?", (owner, request_id)).fetchone()
        if existing:
            if json.loads(existing["snapshot"])["slug"] != slug:
                raise DomainError("重试订单不能更换商品", 409)
            return public_order(existing)
        # A second click or tab should resume the same unpaid product order.
        recent = c.execute("SELECT * FROM v6_orders WHERE owner=? AND state='pending' AND created_at>? ORDER BY created_at DESC", (owner, int(time.time()) - 1800)).fetchall()
        for row in recent:
            if json.loads(row["snapshot"]).get("slug") == slug and json.loads(row["snapshot"]).get("provider") == "alipay":
                return public_order(row)
        latest = next(item for item in catalog(owner) if item["slug"] == slug)
        if not latest["sale_enabled"]:
            raise DomainError("商品销售状态已调整，请重新查看", 409)
        if expected_version is not None and latest["price_version"] != expected_version:
            raise DomainError("商品价格已调整，请重新确认当前价格", 409)
        if latest["price_version"] != product["price_version"] or latest["price_cents"] != product["price_cents"]:
            raise DomainError("商品价格已调整，请重新确认当前价格", 409)
        pay_data = {"payDataType": "payUrl", "payData": _checkout_url(number, snapshot, product["price_cents"], cfg)}
        c.execute("INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,pay_data,created_at) VALUES(?,?,?,?,?,'pending',?,?)",
                  (number, owner, request_id, encoded(snapshot), product["price_cents"], encoded(pay_data), int(time.time())))
    return order(owner, number)


def verify_notification(data):
    cfg = settings()
    if not cfg["public_file"] or data.get("sign_type") != "RSA2" or not data.get("sign"):
        raise DomainError("支付宝通知缺少有效签名", 400)
    _verify(_canonical(data, exclude=("sign", "sign_type")).encode("utf-8"), str(data["sign"]), cfg)


def _cents(value):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount.as_tuple().exponent < -2:
            raise InvalidOperation()
        cents = amount * 100
        if cents != cents.to_integral_value():
            raise InvalidOperation()
        return int(cents)
    except (InvalidOperation, TypeError, ValueError):
        raise DomainError("订单金额无效", 400)


def _apply_full_refund(c, row, trade, now):
    """Apply verified full-refund evidence within the caller's transaction."""
    if row["state"] == "refunded":
        return
    snapshot = json.loads(row["snapshot"])
    c.execute("""UPDATE v6_orders SET state='refunded',refund_cents=amount,
        refund_state='full',refunded_at=?,reconciled_at=?,pay_order_id=? WHERE order_no=?""",
        (now, now, trade, row["order_no"]))
    c.execute("""INSERT OR IGNORE INTO v6_entitlement_revocations
        (owner,feature,source,reason,created_at) VALUES(?,?,?,?,?)""",
        (row["owner"], snapshot["feature"], row["order_no"], "alipay_full_refund", now))
    commerce.recompute_feature(c, row["owner"], snapshot["feature"])
    c.execute("INSERT INTO v6_payment_events(order_no,event,trade_no,amount_cents,created_at) VALUES(?,?,?,?,?)",
              (row["order_no"], "full_refund", trade, row["amount"], now))


def settle(data, *, queried=False):
    """Only call after verified notification or a verified gateway query response."""
    number = str(data.get("out_trade_no", ""))
    now = int(time.time())
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM v6_orders WHERE order_no=?", (number,)).fetchone()
        if not row:
            raise DomainError("订单不存在", 404)
        snapshot = json.loads(row["snapshot"])
        if snapshot.get("provider") != "alipay":
            raise DomainError("历史订单不能由新支付渠道处理", 400)
        if not queried and (data.get("app_id") != snapshot["app_id"] or data.get("seller_id") != snapshot["seller_id"]):
            raise DomainError("支付宝应用或收款主体不一致", 400)
        if queried and data.get("app_id") and data["app_id"] != snapshot["app_id"]:
            raise DomainError("支付宝应用不一致", 400)
        if queried and data.get("seller_id") and data["seller_id"] != snapshot["seller_id"]:
            raise DomainError("收款主体不一致", 400)
        if _cents(data.get("total_amount")) != row["amount"]:
            raise DomainError("订单金额不一致", 400)
        trade = str(data.get("trade_no", ""))
        if not trade or (row["pay_order_id"] and row["pay_order_id"] != trade):
            raise DomainError("支付宝交易号不一致", 400)
        state = str(data.get("trade_status", ""))
        if state == "TRADE_CLOSED":
            if row["state"] == "paid":
                _apply_full_refund(c, row, trade, now)
            elif row["state"] != "refunded":
                c.execute("UPDATE v6_orders SET state='closed',pay_order_id=?,reconciled_at=? WHERE order_no=?",
                          (trade, now, number))
            return
        if state not in ("TRADE_SUCCESS", "TRADE_FINISHED"):
            return
        if row["state"] == "refunded":
            return
        refund = _cents(data["refund_fee"]) if data.get("refund_fee") not in (None, "") else 0
        if refund < 0 or refund > row["amount"]:
            raise DomainError("退款金额无效", 400)
        if row["state"] != "paid":
            base = commerce.current_expiry(c, row["owner"], snapshot["feature"], now)
            expiry = None if base is None else base + snapshot["days"] * 86400
            c.execute("INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,?,?)",
                      (row["owner"], snapshot["feature"], expiry, number))
            c.execute("UPDATE v6_orders SET state='paid',paid_at=?,pay_order_id=?,reconciled_at=? WHERE order_no=?",
                      (now, trade, now, number))
            c.execute("INSERT INTO v6_payment_events(order_no,event,trade_no,amount_cents,created_at) VALUES(?,?,?,?,?)",
                      (number, "paid", trade, row["amount"], now))
        elif _grant_state(c, row, snapshot["feature"]) == "missing":
            # A verified payment may repair a missing source after an interrupted
            # migration; replay the known grants in time order, never append days
            # to the current expiry or revive an explicitly revoked source.
            c.execute("INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,0,?)",
                      (row["owner"], snapshot["feature"], number))
            commerce.recompute_feature(c, row["owner"], snapshot["feature"])
            c.execute("UPDATE v6_orders SET reconciled_at=? WHERE order_no=?", (now, number))
            c.execute("INSERT INTO v6_payment_events(order_no,event,trade_no,amount_cents,created_at) VALUES(?,?,?,?,?)",
                      (number, "grant_repaired", trade, 0, now))
        if refund > row["refund_cents"]:
            c.execute("UPDATE v6_orders SET refund_cents=?,refund_state='partial_review',reconciled_at=? WHERE order_no=?",
                      (refund, now, number))
            c.execute("INSERT INTO v6_payment_events(order_no,event,trade_no,amount_cents,created_at) VALUES(?,?,?,?,?)",
                      (number, "refund_review", trade, refund, now))


def _query_order(number: str, cfg: dict):
    response = _gateway_post("alipay.trade.query", {"out_trade_no": number}, cfg)
    response.raise_for_status()
    raw = response.text
    key = '"alipay_trade_query_response"'
    match = re.search(re.escape(key) + r"\s*:\s*", raw)
    if not match:
        raise DomainError("支付宝查询响应无效", 502)
    try:
        payload, consumed = json.JSONDecoder().raw_decode(raw[match.end():])
        signed = raw[match.end():match.end()+consumed].encode("utf-8")
        envelope = json.loads(raw)
        _verify(signed, envelope["sign"], cfg)
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise DomainError("支付宝查询响应无法校验", 502) from exc
    if payload.get("code") != "10000":
        if payload.get("sub_code") == "ACQ.TRADE_NOT_EXIST":
            return None
        raise DomainError("支付宝订单查询暂不可用，订单已保留", 502)
    if payload.get("out_trade_no") != number:
        raise DomainError("支付宝查询订单号不一致", 502)
    return payload


def refresh(owner, number):
    current = order(owner, number)
    if current["state"] == "legacy_unavailable":
        return current
    if current["state"] == "paid":
        with db.conn() as c:
            row = c.execute("SELECT * FROM v6_orders WHERE order_no=? AND owner=?", (number, owner)).fetchone()
            grant_state = _grant_state(c, row, json.loads(row["snapshot"])["feature"])
        if grant_state == "applied":
            return current
    if not configured():
        raise DomainError("支付查询未配置，订单已保留", 503)
    with db.conn() as c:
        claimed = c.execute("UPDATE v6_orders SET query_at=? WHERE order_no=? AND query_at<?", (int(time.time()), number, int(time.time())-5)).rowcount
    if not claimed:
        if current["state"] == "paid":
            raise DomainError("付款已确认，权益正在核对，请稍后重试", 409)
        return current
    try:
        data = _query_order(number, settings())
        if data:
            settle(data, queried=True)
    except httpx.HTTPError as exc:
        raise DomainError("支付宝查询暂时失败，订单已保留", 502) from exc
    with db.conn() as c:
        latest = c.execute("SELECT * FROM v6_orders WHERE order_no=? AND owner=?", (number, owner)).fetchone()
        if latest["state"] == "paid" and _grant_state(c, latest, json.loads(latest["snapshot"])["feature"]) != "applied":
            raise DomainError("付款已确认，权益需要人工核对，请联系客服", 409)
    return order(owner, number)


def reconcile(number: str):
    """Admin query of a paid or pending direct order, including full refund status."""
    with db.conn() as c:
        row = c.execute("SELECT * FROM v6_orders WHERE order_no=?", (number,)).fetchone()
    if not row:
        raise DomainError("订单不存在", 404)
    if json.loads(row["snapshot"]).get("provider") != "alipay":
        raise DomainError("历史渠道订单无法在支付宝直连查询", 400)
    if not configured():
        raise DomainError("支付查询未配置，订单已保留", 503)
    try:
        data = _query_order(number, settings())
        if data:
            settle(data, queried=True)
    except httpx.HTTPError as exc:
        raise DomainError("支付宝查询暂时失败，订单已保留", 502) from exc
    return order(row["owner"], number)


def _refund_audit(c, actor, action, number, detail):
    c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
              (actor, action, number, encoded(detail), datetime.now().isoformat(timespec="seconds")))


def refund_detail(number):
    with db.conn() as c:
        row = c.execute("SELECT * FROM v6_orders WHERE order_no=?", (number,)).fetchone()
        request = c.execute("SELECT * FROM v6_refund_requests WHERE order_no=?", (number,)).fetchone()
    if not row:
        raise DomainError("订单不存在", 404)
    snapshot = json.loads(row["snapshot"])
    cfg = settings()
    problem = ""
    if snapshot.get("provider") != "alipay":
        problem = "历史渠道订单不能通过支付宝直连退款"
    elif row["state"] != "paid":
        problem = "该订单已退款" if row["state"] == "refunded" else "仅已支付订单可发起退款"
    elif row["refund_cents"] or row["refund_state"]:
        problem = "存在退款记录，请先人工核对；此入口仅支持整笔全额退款"
    elif not configured():
        problem = "支付宝商户尚未配置，当前无法发起退款"
    elif (snapshot.get("app_id"), snapshot.get("seller_id")) != (cfg["app_id"], cfg["seller_id"]):
        problem = "当前支付宝商户与原订单不一致"
    details = None
    if request:
        details = {key: request[key] for key in ("request_no", "amount_cents", "reason", "actor_id",
                   "state", "attempts", "message", "created_at", "updated_at", "next_attempt_at")}
        details["processing"] = request["lease_until"] > int(time.time())
        if row["state"] == "refunded":
            details.update(state="succeeded", message="已确认整笔退款", processing=False)
    return {"order": {**public_order(row), "owner": row["owner"], "trade_no": row["pay_order_id"],
                      "feature": snapshot.get("feature", snapshot.get("slug"))},
            "request": details, "can_refund": not problem, "unavailable_reason": problem}


def _refund_gateway(method, biz, cfg):
    """Verify the exact response bytes before consuming even an error code."""
    response = _gateway_post(method, biz, cfg)
    response.raise_for_status()
    raw = response.text
    key = method.replace(".", "_") + "_response"
    match = re.search(re.escape(json.dumps(key)) + r"\s*:\s*", raw)
    if not match:
        raise DomainError("支付宝退款响应缺失，结果尚未确认", 502)

    def unique_keys(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError("duplicate key")
            result[name] = value
        return result

    try:
        payload, consumed = json.JSONDecoder().raw_decode(raw[match.end():])
        envelope = json.loads(raw, object_pairs_hook=unique_keys)
        if not isinstance(payload, dict) or envelope[key] != payload:
            raise ValueError("invalid response")
        _verify(raw[match.end():match.end()+consumed].encode("utf-8"), envelope["sign"], cfg)
    except (ValueError, KeyError, TypeError) as exc:
        raise DomainError("支付宝退款响应无法校验，结果尚未确认", 502) from exc
    return payload


def _validate_refund_result(payload, row, request, *, queried):
    if payload.get("out_trade_no") != row["order_no"] or payload.get("trade_no") != row["pay_order_id"]:
        raise DomainError("退款响应的订单或交易号不一致", 502)
    if queried and payload.get("out_request_no") != request["request_no"]:
        raise DomainError("退款请求号不一致", 502)
    if payload.get("app_id") and payload["app_id"] != json.loads(row["snapshot"])["app_id"]:
        raise DomainError("退款应用不一致", 502)
    if payload.get("seller_id") and payload["seller_id"] != json.loads(row["snapshot"])["seller_id"]:
        raise DomainError("退款收款主体不一致", 502)
    amount_key = "refund_amount" if queried else "refund_fee"
    if _cents(payload.get(amount_key)) != request["amount_cents"]:
        raise DomainError("退款金额不一致", 502)
    if queried and _cents(payload.get("total_amount")) != row["amount"]:
        raise DomainError("退款对应订单总金额不一致", 502)


def _finish_refund(number, token, actor):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        request = c.execute("SELECT * FROM v6_refund_requests WHERE order_no=?", (number,)).fetchone()
        if not request or request["lease_token"] != token:
            raise DomainError("退款正在由其他请求核对，请刷新状态", 409)
        row = c.execute("SELECT * FROM v6_orders WHERE order_no=?", (number,)).fetchone()
        now = int(time.time())
        _apply_full_refund(c, row, row["pay_order_id"], now)
        c.execute("UPDATE v6_refund_requests SET state='succeeded',message='已确认整笔退款',updated_at=? WHERE order_no=?", (now, number))
        _refund_audit(c, actor, "order_refund_confirmed", number,
                      {"request_no": request["request_no"], "amount_cents": request["amount_cents"]})


def _refund_outcome(number, token, state, message):
    with db.conn() as c:
        c.execute("""UPDATE v6_refund_requests SET state=?,message=?,updated_at=?
            WHERE order_no=? AND lease_token=? AND state!='succeeded'""",
            (state, message, int(time.time()), number, token))


def admin_refund(number, actor, *, action, reason, expected_amount):
    """One persisted full-refund request per order, reused after every unknown result."""
    reason = reason.strip()
    if action not in ("submit", "query") or (action == "submit" and not 2 <= len(reason) <= 200):
        raise DomainError("请填写至少两字的退款原因", 400)
    cfg, now, token = settings(), int(time.time()), secrets.token_hex(16)
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM v6_orders WHERE order_no=?", (number,)).fetchone()
        if not row:
            raise DomainError("订单不存在", 404)
        snapshot = json.loads(row["snapshot"])
        if snapshot.get("provider") != "alipay":
            raise DomainError("历史渠道订单不能通过支付宝直连退款", 409)
        if type(expected_amount) is not int or expected_amount != row["amount"]:
            raise DomainError("请重新确认该订单的完整退款金额", 409)
        if row["state"] == "refunded":
            return refund_detail(number)
        if row["state"] != "paid" or not row["pay_order_id"] or row["amount"] <= 0:
            raise DomainError("仅已确认支付的订单可退款", 409)
        if action == "submit" and (row["refund_cents"] or row["refund_state"]):
            raise DomainError("订单已有退款记录，需要人工复核，不能再次整笔退款", 409)
        if not configured():
            raise DomainError("支付宝商户尚未配置，当前无法发起退款", 503)
        if (snapshot.get("app_id"), snapshot.get("seller_id")) != (cfg["app_id"], cfg["seller_id"]):
            raise DomainError("当前支付宝商户与原订单不一致", 409)
        request = c.execute("SELECT * FROM v6_refund_requests WHERE order_no=?", (number,)).fetchone()
        if request and (request["amount_cents"] != row["amount"] or request["state"] == "succeeded"):
            raise DomainError("本地订单与退款记录不一致，请人工复核", 409)
        if not request:
            if action == "query":
                raise DomainError("该订单尚未发起退款", 409)
            c.execute("""INSERT INTO v6_refund_requests(order_no,request_no,amount_cents,reason,actor_id,state,created_at,updated_at)
                VALUES(?,?,?,?,?,'processing',?,?)""", (number, "RF" + secrets.token_hex(20), row["amount"], reason, actor, now, now))
            request = c.execute("SELECT * FROM v6_refund_requests WHERE order_no=?", (number,)).fetchone()
        if request["lease_until"] > now or request["next_attempt_at"] > now:
            raise DomainError("退款正在核对，请至少十秒后刷新或查询结果", 409)
        c.execute("""UPDATE v6_refund_requests SET lease_token=?,lease_until=?,next_attempt_at=?,
            attempts=attempts+1,state='processing',message='正在核对退款',updated_at=? WHERE order_no=?""",
            (token, now+120, now+10, now, number))
        _refund_audit(c, actor, "order_refund_" + action, number,
                      {"request_no": request["request_no"], "amount_cents": row["amount"], "reason": reason})
    biz = {"out_trade_no": number, "trade_no": row["pay_order_id"], "out_request_no": request["request_no"]}
    try:
        def perform():
            # Every retry queries the original request before any possible resubmission.
            if request["attempts"] or action == "query":
                result = _refund_gateway("alipay.trade.fastpay.refund.query", biz, cfg)
                if result.get("code") == "10000" and result.get("refund_status") == "REFUND_SUCCESS":
                    _validate_refund_result(result, row, request, queried=True)
                    _finish_refund(number, token, actor)
                    return
                if result.get("code") != "10000" and result.get("sub_code") != "ACQ.TRADE_NOT_EXIST":
                    raise DomainError("支付宝退款查询暂不可用，请稍后用原请求查询", 502)
                if action == "query":
                    _refund_outcome(number, token, "unknown", "尚未确认退款成功；可稍后查询或按原请求重试")
                    return
            # Query current trade status first to catch externally completed/partial refunds.
            trade = _query_order(number, cfg)
            if not trade:
                raise DomainError("支付宝未找到原交易，需要人工核对", 502)
            if trade.get("trade_status") not in ("TRADE_SUCCESS", "TRADE_FINISHED", "TRADE_CLOSED"):
                raise DomainError("支付宝原交易尚未确认支付，不能退款", 409)
            settle(trade, queried=True)
            latest = order(row["owner"], number)
            if latest["state"] == "refunded":
                _finish_refund(number, token, actor)
                return
            if latest["refund_cents"] or latest["refund_state"]:
                raise DomainError("发现已有退款记录，请人工复核，未再次发起退款", 409)
            result = _refund_gateway("alipay.trade.refund", {**biz,
                "refund_amount": f"{request['amount_cents']//100}.{request['amount_cents']%100:02d}",
                "refund_reason": request["reason"]}, cfg)
            if result.get("code") == "10000" and result.get("fund_change") == "Y":
                _validate_refund_result(result, row, request, queried=False)
                _finish_refund(number, token, actor)
            else:
                code = str(result.get("sub_code", result.get("code", "unknown")))
                code = code if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", code) else "unknown"
                state = "failed" if result.get("code") == "40004" else "unknown"
                _refund_outcome(number, token, state, f"退款尚未确认成功（{code}）；请查询结果或按原请求重试")
        perform()
    except (httpx.HTTPError, DomainError) as exc:
        message = str(exc) if isinstance(exc, DomainError) else "支付宝连接中断，退款结果尚未确认"
        _refund_outcome(number, token, "unknown", message)
    finally:
        with db.conn() as c:
            c.execute("""UPDATE v6_refund_requests SET lease_token='',lease_until=0,next_attempt_at=?
                WHERE order_no=? AND lease_token=?""", (int(time.time())+10, number, token))
    return refund_detail(number)


_DIRECT_PAID = "v6_orders.state='paid' AND json_extract(v6_orders.snapshot,'$.provider')='alipay'"
_SNAPSHOT_FEATURE = "COALESCE(json_extract(v6_orders.snapshot,'$.feature'),json_extract(v6_orders.snapshot,'$.slug'))"
_REVOKED_GRANT = (_DIRECT_PAID + " AND EXISTS (SELECT 1 FROM v6_entitlement_revocations r WHERE "
                  "r.owner=v6_orders.owner AND r.feature=" + _SNAPSHOT_FEATURE + " "
                  "AND r.source=v6_orders.order_no)")
_MISSING_GRANT = (_DIRECT_PAID + " AND NOT EXISTS (SELECT 1 FROM v6_entitlements e WHERE "
                  "e.owner=v6_orders.owner AND e.feature=" + _SNAPSHOT_FEATURE + " "
                  "AND e.source=v6_orders.order_no) AND NOT EXISTS (SELECT 1 FROM v6_entitlement_revocations r WHERE "
                  "r.owner=v6_orders.owner AND r.feature=" + _SNAPSHOT_FEATURE + " "
                  "AND r.source=v6_orders.order_no)")
_ISSUE_QUERIES = {"missing_grant": _MISSING_GRANT, "revoked_grant": _REVOKED_GRANT,
                  "refund_review": _DIRECT_PAID + " AND v6_orders.refund_state='partial_review'",
                  "refund_pending": "v6_orders.state!='refunded' AND EXISTS (SELECT 1 FROM v6_refund_requests r WHERE r.order_no=v6_orders.order_no AND r.state!='succeeded')"}


def admin_issue_counts():
    with db.conn() as c:
        return {issue: c.execute("SELECT COUNT(*) FROM v6_orders WHERE " + clause).fetchone()[0]
                for issue, clause in _ISSUE_QUERIES.items()}


def admin_orders(*, q="", slug="", state="", provider="", channel="", issue="", from_ts=None,
                 to_ts=None, page=1, page_size=20):
    """Search all V6 orders with bounded pages; historical channel stays identifiable."""
    q = q.strip()
    if len(q) > 80 or page < 1 or not 1 <= page_size <= 100:
        raise DomainError("订单查询参数无效", 400)
    if slug and slug not in CATALOG:
        raise DomainError("商品筛选无效", 400)
    if state and state not in ("pending", "paid", "refunded", "closed", "partial_review", "legacy_unavailable"):
        raise DomainError("订单状态筛选无效", 400)
    if provider and provider not in ("alipay", "historical"):
        raise DomainError("支付来源筛选无效", 400)
    if channel and channel not in ("pc", "mobile", "legacy"):
        raise DomainError("支付方式筛选无效", 400)
    if issue and issue not in _ISSUE_QUERIES:
        raise DomainError("待处理类型筛选无效", 400)
    if any(value is not None and not 0 <= value <= 4102444800 for value in (from_ts, to_ts)) or (from_ts is not None and to_ts is not None and from_ts > to_ts):
        raise DomainError("订单日期范围无效", 400)
    where, args = [], []
    if q:
        term = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append("(owner LIKE ? ESCAPE '\\' OR order_no LIKE ? ESCAPE '\\' OR pay_order_id LIKE ? ESCAPE '\\')")
        args.extend((term, term, term))
    if slug:
        where.append("json_extract(snapshot,'$.slug')=?")
        args.append(slug)
    if state:
        if state == "partial_review":
            where.append("refund_state='partial_review'")
        elif state == "legacy_unavailable":
            where.append("COALESCE(json_extract(snapshot,'$.provider'),'historical')!='alipay' AND state!='paid'")
        else:
            where.append("state=?" + (" AND json_extract(snapshot,'$.provider')='alipay'" if state != "paid" else ""))
            args.append(state)
    if provider:
        where.append("COALESCE(json_extract(snapshot,'$.provider'),'historical')=?")
        args.append(provider)
    if channel:
        where.append("COALESCE(json_extract(snapshot,'$.channel'),'legacy')=?")
        args.append(channel)
    if issue:
        where.append("(" + _ISSUE_QUERIES[issue] + ")")
    if from_ts is not None:
        where.append("created_at>=?")
        args.append(from_ts)
    if to_ts is not None:
        where.append("created_at<=?")
        args.append(to_ts)
    clause = " WHERE " + " AND ".join(where) if where else ""
    with db.conn() as c:
        total = c.execute("SELECT COUNT(*) FROM v6_orders" + clause, args).fetchone()[0]
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        rows = c.execute("SELECT * FROM v6_orders" + clause +
                         " ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?",
                         (*args, page_size, (page - 1) * page_size)).fetchall()
        orders = []
        for row in rows:
            snapshot = json.loads(row["snapshot"])
            issues = []
            if snapshot.get("provider") == "alipay" and row["state"] == "paid":
                feature = snapshot.get("feature") or CATALOG.get(snapshot.get("slug"), {}).get("feature")
                grant = _grant_state(c, row, feature) if feature else "missing"
                if grant == "missing":
                    issues.append("missing_grant")
                elif grant == "revoked":
                    issues.append("revoked_grant")
                if row["refund_state"] == "partial_review":
                    issues.append("refund_review")
            refund_request = c.execute("SELECT state FROM v6_refund_requests WHERE order_no=?", (row["order_no"],)).fetchone()
            if refund_request and refund_request["state"] != "succeeded" and row["state"] != "refunded":
                issues.append("refund_pending")
            orders.append({**public_order(row), "owner": row["owner"], "trade_no": row["pay_order_id"],
                           "provider": snapshot.get("provider", "historical"), "issues": issues})
    return {"orders": orders, "total": total, "page": page, "pages": pages, "page_size": page_size}
