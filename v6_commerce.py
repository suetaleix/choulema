"""Shared product versions and readable entitlement provenance for V6."""
from __future__ import annotations

import json
import base64
import hashlib
import hmac
import os
import secrets
import time
from datetime import datetime

import db


def init_schema(catalog: dict) -> None:
    with db.conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS v6_price_history(
            id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL,
            version INTEGER NOT NULL, price_cents INTEGER NOT NULL,
            sale_visible INTEGER NOT NULL, actor_id INTEGER,
            reason TEXT NOT NULL, created_at INTEGER NOT NULL,
            UNIQUE(slug,version))""")
        for slug, product in catalog.items():
            raw = db.get_setting("v6_price_" + slug, str(product["price_cents"]))
            price = int(raw) if raw.isdigit() and 0 < int(raw) <= 1_000_000 else product["price_cents"]
            c.execute("""INSERT OR IGNORE INTO v6_price_history(
                slug,version,price_cents,sale_visible,actor_id,reason,created_at)
                VALUES(?,1,?,?,NULL,'initial',?)""", (slug, price, 1, int(time.time())))
        c.executescript("""CREATE TABLE IF NOT EXISTS v6_card_batches(
            id TEXT PRIMARY KEY, feature TEXT NOT NULL, days INTEGER NOT NULL,
            quantity INTEGER NOT NULL, label TEXT NOT NULL, purpose TEXT NOT NULL,
            redeem_deadline INTEGER, actor_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS v6_cards(
            id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES v6_card_batches(id),
            code_hash TEXT NOT NULL UNIQUE, suffix TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'issued', redeemed_owner TEXT,
            redeemed_at INTEGER, voided_at INTEGER);
        CREATE INDEX IF NOT EXISTS idx_v6_cards_batch ON v6_cards(batch_id,state);""")
        c.execute("""CREATE TABLE IF NOT EXISTS v6_entitlement_revocations(
            source TEXT NOT NULL, owner TEXT NOT NULL, feature TEXT NOT NULL,
            reason TEXT NOT NULL, created_at INTEGER NOT NULL,
            PRIMARY KEY(owner,feature,source))""")


def _legacy_expiry(c, owner: str, feature: str) -> int:
    if feature not in ("pro", "cosmic") or not owner.startswith("user:"):
        return 0
    uid = int(owner.split(":", 1)[1])
    member = c.execute("SELECT expires_at FROM memberships WHERE subject_type='user' AND subject_id=? AND plan='year'", (uid,)).fetchone()
    if not member:
        return 0
    try:
        return int(datetime.fromisoformat(member["expires_at"]).timestamp())
    except ValueError:
        return 0


def current_expiry(c, owner: str, feature: str, now: int) -> int | None:
    """Return current end; None means a permanent grant, and 0 means no grant."""
    row = c.execute("""SELECT MAX(e.expires_at) expiry,
        SUM(CASE WHEN e.expires_at IS NULL THEN 1 ELSE 0 END) permanent
        FROM v6_entitlements e LEFT JOIN v6_entitlement_revocations r
        ON r.owner=e.owner AND r.feature=e.feature AND r.source=e.source
        WHERE e.owner=? AND e.feature=? AND r.source IS NULL""", (owner, feature)).fetchone()
    if row["permanent"]:
        return None
    return max(now, row["expiry"] or 0, _legacy_expiry(c, owner, feature))


def recompute_feature(c, owner: str, feature: str) -> None:
    """Rebase surviving timed grants after a refunded source is revoked.

    Unknown historical sources are preserved as a floor. Known card and direct
    payment grants retain their original duration and event time.
    """
    grants = []
    baseline = _legacy_expiry(c, owner, feature)
    permanent = False
    rows = c.execute("""SELECT e.source,e.expires_at,r.source revoked
        FROM v6_entitlements e LEFT JOIN v6_entitlement_revocations r
        ON r.owner=e.owner AND r.feature=e.feature AND r.source=e.source
        WHERE e.owner=? AND e.feature=?""", (owner, feature)).fetchall()
    for row in rows:
        if row["revoked"]:
            continue
        source = row["source"]
        if source.startswith('admin:v7:') and c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v7_manual_grants'").fetchone():
            grant = c.execute('SELECT id,created_at,days FROM v7_manual_grants WHERE source=? AND owner=? AND feature=?',(source,owner,feature)).fetchone()
            if grant:
                grants.append((grant['created_at'],3,grant['id'],source,grant['days']))
                continue
        if source.startswith("invite:") and c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v7_reward_grants'").fetchone():
            grant = c.execute("SELECT id,created_at,days FROM v7_reward_grants WHERE source=? AND owner=? AND feature=?", (source, owner, feature)).fetchone()
            if grant:
                grants.append((grant["created_at"], 2, grant["id"], source, grant["days"]))
                continue
        if source.startswith("card:"):
            card = c.execute("""SELECT c.redeemed_at,b.days,c.rowid sequence FROM v6_cards c
                JOIN v6_card_batches b ON b.id=c.batch_id WHERE c.id=? AND c.state='redeemed'""", (source[5:],)).fetchone()
            if card:
                grants.append((card["redeemed_at"], 1, card["sequence"], source, card["days"]))
                continue
        order = c.execute("""SELECT o.rowid sequence,o.snapshot,o.paid_at,o.created_at,o.state,
            (SELECT MIN(p.id) FROM v6_payment_events p WHERE p.order_no=o.order_no AND p.event='paid') paid_sequence
            FROM v6_orders o WHERE o.order_no=?""", (source,)).fetchone()
        if order and order["state"] == "paid":
            snapshot = json.loads(order["snapshot"])
            if snapshot.get("provider") == "alipay" and snapshot.get("feature") == feature:
                grants.append((order["paid_at"] or order["created_at"], 0,
                               order["paid_sequence"] or order["sequence"], source, snapshot["days"]))
                continue
        if row["expires_at"] is None:
            permanent = True
        else:
            baseline = max(baseline, row["expires_at"])
    end = None if permanent else baseline
    # Stored timestamps are seconds. Payment event IDs preserve confirmation
    # order within one second; old rows without events fall back to row order.
    for occurred, _, _, source, days in sorted(grants):
        if end is None or not days:
            end = None
        else:
            end = max(end, occurred) + days * 86400
        c.execute("UPDATE v6_entitlements SET expires_at=? WHERE owner=? AND feature=? AND source=?",
                  (end, owner, feature, source))


def _card_key() -> bytes:
    configured = os.getenv("LOTTERY_CARD_SECRET", "")
    if configured:
        if len(configured) < 32:
            raise ValueError("LOTTERY_CARD_SECRET 至少 32 字符")
        return configured.encode()
    # Development fallback persists across restarts. Production should configure
    # an independent secret outside the database before issuing cards.
    with db.conn() as c:
        c.execute("INSERT OR IGNORE INTO settings(k,v) VALUES('v6_card_local_secret',?)", (secrets.token_hex(32),))
        return c.execute("SELECT v FROM settings WHERE k='v6_card_local_secret'").fetchone()[0].encode()


def _card_digest(code: str) -> str:
    normalized = code.strip().upper().replace("-", "")
    return hmac.new(_card_key(), normalized.encode(), hashlib.sha256).hexdigest()


def generate_cards(feature: str, days: int, quantity: int, label: str, purpose: str,
                   redeem_deadline: int | None, actor_id: int, catalog: dict) -> dict:
    if feature not in {item["feature"] for item in catalog.values()}:
        raise ValueError("请选择有效的功能会员或皮肤")
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 3650:
        raise ValueError("使用期限应为 1 至 3650 天")
    if not isinstance(quantity, int) or isinstance(quantity, bool) or not 1 <= quantity <= 200:
        raise ValueError("每批生成 1 至 200 张")
    if not 1 <= len(label.strip()) <= 80 or len(purpose.strip()) > 200:
        raise ValueError("请填写批次名称，用途不超过 200 字")
    now = int(time.time())
    if redeem_deadline is not None and (redeem_deadline < now or redeem_deadline > now + 10 * 365 * 86400):
        raise ValueError("兑换截止日应晚于今天，且不超过 10 年")
    batch_id = secrets.token_hex(12)
    cards = []
    for _ in range(quantity):
        raw = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
        code = "CLM-" + "-".join(raw[i:i+8] for i in range(0, len(raw), 8))
        cards.append({"id": secrets.token_hex(12), "code": code, "hash": _card_digest(code), "suffix": raw[-4:]})
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute("INSERT INTO v6_card_batches VALUES(?,?,?,?,?,?,?,?,?)",
                  (batch_id, feature, days, quantity, label.strip(), purpose.strip(), redeem_deadline, actor_id, now))
        c.executemany("INSERT INTO v6_cards(id,batch_id,code_hash,suffix) VALUES(?,?,?,?)",
                      [(card["id"], batch_id, card["hash"], card["suffix"]) for card in cards])
        c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
                  (actor_id, "card_batch_generate_export", f"card_batch:{batch_id}",
                   json.dumps({"feature": feature, "days": days, "quantity": quantity, "label": label.strip()}, ensure_ascii=False),
                   datetime.now().isoformat(timespec="seconds")))
    return {"batch_id": batch_id, "feature": feature, "days": days, "quantity": quantity,
            "codes": [card["code"] for card in cards], "one_time_export": True}


def list_card_batches() -> list[dict]:
    with db.conn() as c:
        rows = c.execute("""SELECT b.*,SUM(CASE WHEN c.state='issued' AND (b.redeem_deadline IS NULL OR b.redeem_deadline>=?) THEN 1 ELSE 0 END) issued,
            SUM(CASE WHEN c.state='issued' AND b.redeem_deadline<? THEN 1 ELSE 0 END) expired,
            SUM(CASE WHEN c.state='redeemed' THEN 1 ELSE 0 END) redeemed,
            SUM(CASE WHEN c.state='void' THEN 1 ELSE 0 END) voided
            FROM v6_card_batches b JOIN v6_cards c ON c.batch_id=b.id
            GROUP BY b.id ORDER BY b.created_at DESC,b.rowid DESC LIMIT 100""", (int(time.time()), int(time.time()))).fetchall()
    return [dict(row) for row in rows]


def list_batch_cards(batch_id: str) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("""SELECT c.id,c.suffix,c.state,c.redeemed_owner,c.redeemed_at,c.voided_at,b.redeem_deadline
            FROM v6_cards c JOIN v6_card_batches b ON b.id=c.batch_id WHERE c.batch_id=? ORDER BY c.rowid""", (batch_id,)).fetchall()
    now = int(time.time())
    return [{**dict(row), "state": "expired" if row["state"] == "issued" and row["redeem_deadline"] is not None and row["redeem_deadline"] < now else row["state"]} for row in rows]


def void_card(card_id: str, actor_id: int, reason: str) -> bool:
    if len(reason.strip()) < 2 or len(reason) > 200:
        raise ValueError("请填写作废原因")
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        changed = c.execute("UPDATE v6_cards SET state='void',voided_at=? WHERE id=? AND state='issued'", (int(time.time()), card_id)).rowcount
        if changed:
            c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
                      (actor_id, "card_void", f"card:{card_id}", json.dumps({"reason": reason.strip()}, ensure_ascii=False), datetime.now().isoformat(timespec="seconds")))
        return bool(changed)


def redeem_card(code: str, uid: int) -> dict:
    if len(code) > 100 or len(code) < 20:
        raise ValueError("卡密格式不正确")
    digest = _card_digest(code)
    owner = f"user:{uid}"
    now = int(time.time())
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        user = c.execute("SELECT status FROM users WHERE id=?", (uid,)).fetchone()
        if not user or user["status"] != "active":
            raise ValueError("账号不可兑换，请联系管理员")
        row = c.execute("""SELECT c.*,b.feature,b.days,b.redeem_deadline FROM v6_cards c
            JOIN v6_card_batches b ON b.id=c.batch_id WHERE c.code_hash=?""", (digest,)).fetchone()
        if not row:
            raise ValueError("卡密不存在")
        if row["state"] == "redeemed":
            if row["redeemed_owner"] == owner:
                return {"feature": row["feature"], "already_redeemed": True, "expires_at": c.execute(
                    "SELECT expires_at FROM v6_entitlements WHERE owner=? AND feature=? AND source=?",
                    (owner, row["feature"], "card:" + row["id"])).fetchone()[0]}
            raise ValueError("卡密已被使用")
        if row["state"] == "void":
            raise ValueError("卡密已作废")
        if row["redeem_deadline"] is not None and now > row["redeem_deadline"]:
            raise ValueError("卡密已过兑换截止日")
        base = current_expiry(c, owner, row["feature"], now)
        expiry = None if base is None else base + row["days"] * 86400
        c.execute("INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,?,?)",
                  (owner, row["feature"], expiry, "card:" + row["id"]))
        c.execute("UPDATE v6_cards SET state='redeemed',redeemed_owner=?,redeemed_at=? WHERE id=?", (owner, now, row["id"]))
        return {"feature": row["feature"], "already_redeemed": False, "expires_at": expiry}


def product_state(slug: str, default_price: int) -> dict:
    raw = db.get_setting("v6_price_" + slug, str(default_price))
    price = int(raw) if raw.isdigit() and 0 < int(raw) <= 1_000_000 else None
    with db.conn() as c:
        row = c.execute("SELECT version FROM v6_price_history WHERE slug=? ORDER BY version DESC LIMIT 1", (slug,)).fetchone()
    return {"price_cents": price, "price_version": row["version"] if row else 1,
            "sale_visible": db.get_setting("v6_sale_" + slug, "1") == "1"}


def set_product(slug: str, price_cents: int, sale_visible: bool, actor_id: int, reason: str, catalog: dict) -> dict:
    if slug not in catalog or not isinstance(price_cents, int) or isinstance(price_cents, bool) or not 1 <= price_cents <= 1_000_000:
        raise ValueError("商品或价格无效，价格应为 0.01 至 10000 元")
    if len(reason.strip()) < 2 or len(reason) > 200:
        raise ValueError("请填写 2 至 200 字的调整原因")
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT version FROM v6_price_history WHERE slug=? ORDER BY version DESC LIMIT 1", (slug,)).fetchone()
        version = (row["version"] if row else 0) + 1
        now = int(time.time())
        c.execute("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", ("v6_price_" + slug, str(price_cents)))
        c.execute("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", ("v6_sale_" + slug, "1" if sale_visible else "0"))
        c.execute("INSERT INTO v6_price_history(slug,version,price_cents,sale_visible,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?)",
                  (slug, version, price_cents, int(sale_visible), actor_id, reason.strip(), now))
        c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
                  (actor_id, "product_change", f"product:{slug}", json.dumps({"version": version, "price_cents": price_cents, "sale_visible": sale_visible, "reason": reason.strip()}, ensure_ascii=False), datetime.now().isoformat(timespec="seconds")))
    return {"slug": slug, "price_cents": price_cents, "price_version": version, "sale_visible": sale_visible}


def price_history(slug: str, catalog: dict) -> list[dict]:
    if slug not in catalog:
        raise ValueError("商品不存在")
    with db.conn() as c:
        rows = c.execute("SELECT version,price_cents,sale_visible,actor_id,reason,created_at FROM v6_price_history WHERE slug=? ORDER BY version DESC LIMIT 100", (slug,)).fetchall()
    return [dict(row) for row in rows]


def product_metadata(c,slug,product):
    row=c.execute('SELECT v FROM settings WHERE k=?',('v7_catalog_'+slug,)).fetchone()
    saved=json.loads(row['v']) if row else {}
    return {'sort_order':saved.get('sort_order',product.get('sort_order',0)),
            'giftable':saved.get('giftable',product.get('giftable',True)),
            'metadata_version':saved.get('metadata_version',1)}


def set_product_metadata(slug,sort_order,giftable,version,reason,actor,catalog):
    from v6_engine import DomainError
    if slug not in catalog:
        raise DomainError('商品不存在',404)
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        before=product_metadata(c,slug,catalog[slug])
        if version!=before['metadata_version']:
            raise DomainError('商品展示设置已由其他管理员更新，请刷新后再修改',409)
        after={'sort_order':sort_order,'giftable':giftable,'metadata_version':version+1}
        c.execute('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',
                  ('v7_catalog_'+slug,json.dumps(after)))
        c.execute('INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)',
                  (actor,'product_metadata',slug,json.dumps({'before':before,'after':after,'reason':reason},ensure_ascii=False),datetime.now().isoformat(timespec='seconds')))
    return after


def entitlement_details(owner: str) -> dict:
    """Show all sources while resolving each feature by its longest valid term."""
    now = int(time.time())
    rows = []
    with db.conn() as c:
        manual = {r['source']:r['id'] for r in c.execute('SELECT id,source FROM v7_manual_grants WHERE owner=?',(owner,))} if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v7_manual_grants'").fetchone() else {}
        for row in c.execute("""SELECT e.feature,e.expires_at,e.source,r.reason revoked_reason
            FROM v6_entitlements e LEFT JOIN v6_entitlement_revocations r
            ON r.owner=e.owner AND r.feature=e.feature AND r.source=e.source
            WHERE e.owner=? ORDER BY e.feature,e.expires_at DESC""", (owner,)):
            source = row["source"]
            kind = "referral" if source.startswith("invite:") else "card" if source.startswith("card:") else "admin" if source.startswith("admin:") else "online"
            rows.append({"feature": row["feature"], "expires_at": row["expires_at"], "source": source,
                         "source_kind": kind, "revoked": bool(row["revoked_reason"]),
                         "manual_grant_id": manual.get(source),
                         "active": not row["revoked_reason"] and (row["expires_at"] is None or row["expires_at"] > now)})
        if owner.startswith("user:"):
            uid = int(owner.split(":", 1)[1])
            user = c.execute("SELECT role FROM users WHERE id=?", (uid,)).fetchone()
            member = c.execute("SELECT expires_at FROM memberships WHERE subject_type='user' AND subject_id=? AND plan='year'", (uid,)).fetchone()
            if member:
                try:
                    expiry = int(datetime.fromisoformat(member["expires_at"]).timestamp())
                except ValueError:
                    expiry = 0
                for feature in ("pro", "cosmic"):
                    rows.append({"feature": feature, "expires_at": expiry, "source": "legacy-membership",
                                 "source_kind": "legacy", "active": expiry > now})
            if user and user["role"] == "superadmin":
                for feature in ("pro", "cosmic"):
                    rows.append({"feature": feature, "expires_at": None, "source": "superadmin",
                                 "source_kind": "admin", "active": True})
    effective = {}
    for row in rows:
        if not row["active"]:
            continue
        feature = row["feature"]
        current = effective.get(feature)
        if current is None or row["expires_at"] is None or (current["expires_at"] is not None and row["expires_at"] > current["expires_at"]):
            effective[feature] = {"expires_at": row["expires_at"], "source_kind": row["source_kind"]}
    return {"features": effective, "sources": rows}


def admin_overview() -> dict:
    now = int(time.time())
    today = datetime.now().date().isoformat()
    with db.conn() as c:
        users = c.execute("SELECT id,status FROM users").fetchall()
        orders = c.execute("SELECT snapshot,amount,state,paid_at,refund_cents,refund_state FROM v6_orders").fetchall()
        card_counts = {row["state"]: row["n"] for row in c.execute("SELECT state,COUNT(*) n FROM v6_cards GROUP BY state")}
    paid = [row for row in orders if row["paid_at"] and json.loads(row["snapshot"]).get("provider") == "alipay"]
    from v6_engine import features
    active_ids = [row["id"] for row in users if row["status"] == "active"]
    pro = cosmic = 0
    for uid in active_ids:
        owned = features(f"user:{uid}")
        pro += "pro" in owned
        cosmic += "cosmic" in owned
    return {"as_of": now, "period": "all_time", "accounts": len(users), "active_accounts": len(active_ids),
            "disabled_accounts": len(users) - len(active_ids), "pro_accounts": pro, "cosmic_accounts": cosmic,
            "alipay_paid_orders": len(paid), "alipay_paid_cents": sum(row["amount"] for row in paid),
            "alipay_paid_today_cents": sum(row["amount"] for row in paid if row["paid_at"] and datetime.fromtimestamp(row["paid_at"]).date().isoformat() == today),
            "alipay_refund_cents": sum(row["refund_cents"] for row in paid),
            "alipay_net_cents": sum(row["amount"]-row["refund_cents"] for row in paid),
            "refund_review_orders": sum(row["refund_state"] == "partial_review" for row in paid),
            "cards_issued": card_counts.get("issued", 0), "cards_redeemed": card_counts.get("redeemed", 0),
            "cards_void": card_counts.get("void", 0)}


def admin_audit(limit: int = 100) -> list[dict]:
    with db.conn() as c:
        rows = c.execute("SELECT a.id,a.actor_id,u.custom_id actor,a.action,a.target,a.detail,a.created_at FROM admin_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]
