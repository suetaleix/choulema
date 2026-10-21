"""Database layer for the 3D lottery platform.

Single-file SQLite store. Models:
  User       - accounts (verified email, optional legacy phone, account id, role, status)
  Template   - per-user draw templates (type, copy fields, mode, items / people)
  PlayLog    - per-draw audit + daily count enforcement
"""
from __future__ import annotations

import os
import sqlite3
import hashlib
import secrets
import random
import time
import json
import math
import re
from datetime import date, datetime
from typing import Optional

DB_PATH = os.environ.get("LOTTERY_DB", os.path.join(os.path.dirname(__file__), "data", "db.sqlite"))

# Super-admin seeded on first boot
SUPERADMIN_PHONE = os.environ.get("LOTTERY_ADMIN_PHONE", "")
SUPERADMIN_PASSWORD = os.environ.get("LOTTERY_ADMIN_PASSWORD", "")
SUPERADMIN_CUSTOM_ID = os.environ.get("LOTTERY_ADMIN_ID", "admin")

DAILY_LIMIT = 100              # 注册用户每天(注册即送100次/天)
GUEST_DAILY_LIMIT = 10         # 每游客每天(用完引导注册: 注册送100/天)
IP_GUEST_DAILY_LIMIT = 30      # 每IP每天(所有游客合计, 超管可调)
MEMBER_PRICE_CENTS = 9900      # 会员 99 元/年(分)
MEMBER_DAYS = 365

# Template types
T_DISH = "dish"        # 抽菜品: 等权随机, 公平
T_PRIZE = "prize"      # 抽奖品: 模式 chose -> normal / no_repeat / weighted
T_PERSON = "person"    # 抽人:   导入名单, 一次抽 N 人

# Prize modes
M_NORMAL = "normal"        # 普通: 每次独立等权
M_NO_REPEAT = "no_repeat"  # 不重复: 抽过的本轮不再出现(直到重置)
M_WEIGHTED = "weighted"    # 权重: 按 item.weight 加权

PRIZE_MODES = {M_NORMAL, M_NO_REPEAT, M_WEIGHTED}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _hash(pwd: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pwd.encode(), salt.encode(), 260000).hex()
    return f"pbkdf2_sha256$260000${salt}${digest}"


def _password_matches(stored: str, password: str) -> bool:
    if stored.startswith("pbkdf2_sha256$"):
        try:
            _, iterations, salt, expected = stored.split("$")
            actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
        except (ValueError, TypeError):
            return False
    else:
        expected, actual = stored, hashlib.sha256(password.encode()).hexdigest()
    return secrets.compare_digest(actual, expected)


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=15, factory=ClosingConnection)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


def init_db() -> None:
    c = conn()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE,
            custom_id TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            status TEXT NOT NULL DEFAULT 'active',
            daily_count INTEGER NOT NULL DEFAULT 0,
            last_play_date TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'dish',
            mode TEXT NOT NULL DEFAULT 'normal',
            subtitle TEXT NOT NULL DEFAULT '',
            rule TEXT NOT NULL DEFAULT '',
            theme TEXT NOT NULL DEFAULT '',
            positive_title TEXT NOT NULL DEFAULT '',
            negative_title TEXT NOT NULL DEFAULT '',
            draw_count INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            template_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            img TEXT,
            weight INTEGER NOT NULL DEFAULT 1,
            category TEXT DEFAULT '',
            FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS guests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guest_key TEXT UNIQUE NOT NULL,          -- 随机token,存cookie
            ip TEXT NOT NULL DEFAULT '',
            daily_count INTEGER NOT NULL DEFAULT 0,
            last_play_date TEXT NOT NULL DEFAULT '',
            user_id INTEGER,                          -- 注册后可合并
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_type TEXT NOT NULL,               -- 'user' | 'guest'
            subject_id INTEGER NOT NULL,
            plan TEXT NOT NULL DEFAULT 'year',
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(subject_type, subject_id, plan)
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT UNIQUE NOT NULL,            -- 本地订单号
            jeepay_trade_no TEXT,                     -- 历史支付渠道单号，保留旧字段名供读取
            subject_type TEXT NOT NULL,
            subject_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,                  -- 分
            status TEXT NOT NULL DEFAULT 'created',   -- created/paid/failed/closed
            pay_type TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            paid_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_orders_subject ON orders(subject_type, subject_id);
        CREATE TABLE IF NOT EXISTS guest_play_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guest_id INTEGER NOT NULL,
            result TEXT,
            played_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS play_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            template_id INTEGER,
            result TEXT,
            played_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    c.commit()
    _migrate_email_identity(c)
    _migrate(c)
    _seed_superadmin(c)
    c.close()
    _migrate_play_log()
    _ensure_settings_table()
    _ensure_feedback_table()
    _ensure_shop_tables()
    _ensure_lists_tables()
    init_default_products()
    with conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)")
        c.execute("""CREATE TABLE IF NOT EXISTS admin_audit(
            id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL,
            action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL,
            created_at TEXT NOT NULL)""")
        from email_auth import init_schema
        init_schema(c)
        from v8_feedback import init_schema as init_feedback
        init_feedback(c)


def _migrate_email_identity(c: sqlite3.Connection) -> None:
    """SQLite's table rebuild removes only phone's NOT NULL, preserving IDs and dependents."""
    columns = list(c.execute('PRAGMA table_info(users)'))
    if next(row for row in columns if row[1] == 'phone')[3]:
        c.commit()
        c.execute('PRAGMA foreign_keys=OFF')
        try:
            c.execute('BEGIN IMMEDIATE')
            original = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()[0]
            definition, count = re.subn(r'((?:"phone"|phone)\s+TEXT\b[^,]*?)\bNOT\s+NULL\b', r'\1', original, flags=re.I)
            if count != 1:
                raise RuntimeError('Unsupported legacy phone constraint; migrate offline before starting')
            definition, count = re.subn(r'^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"users"|users)(?=\s*\()', r'\1users_email_upgrade', definition, flags=re.I)
            if count != 1:
                raise RuntimeError('Unsupported legacy users table definition')
            objects = [row[0] for row in c.execute("SELECT sql FROM sqlite_master WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL")]
            sequence = c.execute("SELECT seq FROM sqlite_sequence WHERE name='users'").fetchone()
            names = ','.join('"'+row[1].replace('"','""')+'"' for row in columns)
            c.execute(definition)
            c.execute(f'INSERT INTO users_email_upgrade({names}) SELECT {names} FROM users')
            c.execute('DROP TABLE users')
            c.execute('ALTER TABLE users_email_upgrade RENAME TO users')
            for sql in objects:
                c.execute(sql)
            if sequence:
                c.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='users'", (sequence[0],))
            if c.execute('PRAGMA foreign_key_check').fetchone():
                raise RuntimeError('Foreign key check failed during email identity migration')
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.execute('PRAGMA foreign_keys=ON')
    present = {row[1] for row in c.execute('PRAGMA table_info(users)')}
    if 'email' not in present:
        c.execute('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE')
    if 'email_verified_at' not in present:
        c.execute('ALTER TABLE users ADD COLUMN email_verified_at TEXT')
    c.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL')
    c.commit()


def _seed_superadmin(c: sqlite3.Connection) -> None:
    if not SUPERADMIN_PHONE or not SUPERADMIN_PASSWORD:
        return
    row = c.execute("SELECT id FROM users WHERE phone = ?", (SUPERADMIN_PHONE,)).fetchone()
    if row:
        return
    c.execute(
        "INSERT INTO users (phone, custom_id, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)",
        (SUPERADMIN_PHONE, SUPERADMIN_CUSTOM_ID, _hash(SUPERADMIN_PASSWORD), "superadmin", "active", _now()),
    )
    c.commit()
    uid = c.execute("SELECT id FROM users WHERE phone=?", (SUPERADMIN_PHONE,)).fetchone()["id"]
    _seed_default_templates(c, uid)


# ---------------- Users ----------------

MAX_USERS = int(os.environ.get("LOTTERY_MAX_USERS", "0"))


def count_registrations_today(ip: str) -> int:
    """同IP今日注册数(注册频控)"""
    c = conn()
    today = _now()[:10]
    n = c.execute("SELECT COUNT(*) n FROM users WHERE reg_ip=? AND created_at>=?", (ip, today)).fetchone()["n"]
    c.close()
    return n


def count_users() -> int:
    c = conn()
    n = c.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    c.close()
    return n


def create_user(phone: str | None, custom_id: str, password: str, reg_ip: str = "", on_created=None,
                *, email: str | None = None, before_create=None) -> tuple[bool, str]:
    password_hash = _hash(password)
    c = conn()
    try:
        c.execute('BEGIN IMMEDIATE')
        if MAX_USERS > 0 and c.execute('SELECT COUNT(*) FROM users').fetchone()[0] >= MAX_USERS:
            return False, f"注册用户已达上限（{MAX_USERS}），暂不接受新注册"
        if not phone and not email:
            return False, '请提供邮箱'
        if email and before_create is None:
            return False, '请先完成邮箱验证'
        if before_create is not None:
            error = before_create(c)
            if error:
                c.commit()  # Persist incorrect-code counters without creating an account.
                return False, error
        cursor = c.execute(
            "INSERT INTO users (phone, custom_id, password_hash, role, reg_ip, created_at,email,email_verified_at) VALUES (?,?,?,?,?,?,?,?)",
            (phone, custom_id, password_hash, "user", reg_ip, _now(), email, _now() if email else None),
        )
        uid = cursor.lastrowid
        if on_created is not None:
            on_created(c, uid)
        _seed_default_templates(c, uid, commit=False)
        c.commit()
        return True, ""
    except sqlite3.IntegrityError as e:
        msg = str(e)
        if "email" in msg:
            return False, "该邮箱已注册，请直接登录"
        if "phone" in msg:
            return False, "手机号已注册"
        if "custom_id" in msg:
            return False, "自定义ID已被占用"
        return False, "注册失败"
    finally:
        c.close()


def authenticate(phone: str, password: str) -> Optional[dict]:
    c = conn()
    identifier = phone.strip()
    if '@' in identifier:
        from email_auth import normalize_email, EmailError
        try:
            identifier = normalize_email(identifier)
        except EmailError:
            c.close()
            return None
        row = c.execute("SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL", (identifier,)).fetchone()
    else:
        # Preserve legacy phone API login while account ID is the UI alternative.
        rows = c.execute("SELECT * FROM users WHERE custom_id=? OR phone=?", (identifier,identifier)).fetchall()
        matches = [r for r in rows if _password_matches(r['password_hash'], password)]
        row = matches[0] if len(matches) == 1 else None
    c.close()
    if not row:
        return None
    stored = row["password_hash"]
    if '@' in identifier and not _password_matches(stored, password):
        return None
    if not stored.startswith("pbkdf2_sha256$"):
        with conn() as c:
            c.execute("UPDATE users SET password_hash=? WHERE id=?", (_hash(password), row["id"]))
    return dict(row)


def get_user(uid: int) -> Optional[dict]:
    c = conn()
    row = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    c.close()
    return dict(row) if row else None


def user_public(u: dict) -> dict:
    can_draw = u["status"] == "active"
    return {
        "id": u["id"], "phone": u["phone"], "custom_id": u["custom_id"],
        "email": u.get("email"), "email_verified": bool(u.get("email_verified_at")),
        "role": u["role"], "status": u["status"], "daily_count": u["daily_count"],
        "last_play_date": u["last_play_date"], "created_at": u["created_at"],
        "can_draw": can_draw, "must_change_password": bool(u.get("must_change_password", 0)),
    }


def change_password(uid: int, current: str, replacement: str) -> bool:
    with conn() as c:
        c.execute("BEGIN IMMEDIATE")
        user = c.execute("SELECT password_hash,status FROM users WHERE id=?", (uid,)).fetchone()
        if not user or user["status"] != "active" or not _password_matches(user["password_hash"], current):
            return False
        c.execute("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?", (_hash(replacement), uid))
        c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        return True


def reset_user_password(uid: int, actor_id: int, reason: str = "管理员重置密码") -> str | None:
    if uid == actor_id:
        return None
    temporary = secrets.token_urlsafe(18)
    with conn() as c:
        c.execute("BEGIN IMMEDIATE")
        target = c.execute("SELECT id FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            return None
        c.execute("UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?", (_hash(temporary), uid))
        c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
                  (actor_id, "password_reset", f"user:{uid}", json.dumps({"reason": reason.strip()}, ensure_ascii=False), _now()))
    return temporary


# ---------------- Guests & Membership (SaaS) ----------------

def get_or_create_guest(guest_key: str, ip: str = "") -> dict:
    c = conn()
    row = c.execute("SELECT * FROM guests WHERE guest_key=?", (guest_key,)).fetchone()
    if not row:
        c.execute("INSERT INTO guests (guest_key, ip, created_at) VALUES (?,?,?)", (guest_key, ip, _now()))
        c.commit()
        row = c.execute("SELECT * FROM guests WHERE guest_key=?", (guest_key,)).fetchone()
    g = dict(row)
    c.close()
    return g


def ip_guest_play_count(ip: str) -> int:
    """该IP下所有游客今日合计抽取次数"""
    c = conn()
    today = date.today().isoformat()
    n = c.execute("SELECT COALESCE(SUM(daily_count),0) n FROM guests WHERE ip=? AND last_play_date=?",
                  (ip, today)).fetchone()["n"]
    c.close()
    return n


def check_and_count_guest(guest_key: str) -> tuple[bool, str, int]:
    """游客配额: 300/天/游客 + 1000/天/IP。返回(allowed, msg, remaining)"""
    c = conn()
    today = date.today().isoformat()
    g = c.execute("SELECT * FROM guests WHERE guest_key=?", (guest_key,)).fetchone()
    if not g:
        c.close(); return False, "游客会话无效", 0
    if g["last_play_date"] != today:
        c.execute("UPDATE guests SET daily_count=0, last_play_date=? WHERE id=?", (today, g["id"]))
        g = c.execute("SELECT * FROM guests WHERE id=?", (g["id"],)).fetchone()
    try: gl = int(get_setting("guest_daily_limit", str(GUEST_DAILY_LIMIT)))
    except ValueError: gl = GUEST_DAILY_LIMIT
    if g["daily_count"] >= gl:
        c.close(); return False, f"今日免费次数已用完（{gl} 次），免费注册立送 100 次/天～", 0
    ipn = c.execute("SELECT COALESCE(SUM(daily_count),0) n FROM guests WHERE ip=? AND last_play_date=?",
                    (g["ip"], today)).fetchone()["n"]
    try: ipl = int(get_setting("ip_daily_limit", str(IP_GUEST_DAILY_LIMIT)))
    except ValueError: ipl = IP_GUEST_DAILY_LIMIT
    if ipn >= ipl:
        c.close(); return False, "当前网络今日游客额度已用完～ 免费注册立送 100 次/天～", 0
    c.execute("UPDATE guests SET daily_count = daily_count + 1 WHERE id=?", (g["id"],))
    c.commit(); c.close()
    remaining = max(0, gl - g["daily_count"] - 1)
    return True, "", remaining


def is_member(subject_type: str, subject_id: int) -> bool:
    c = conn()
    row = c.execute("SELECT expires_at FROM memberships WHERE subject_type=? AND subject_id=? AND plan='year'",
                    (subject_type, subject_id)).fetchone()
    c.close()
    if not row:
        return False
    return row["expires_at"] > _now()


def member_expiry(subject_type: str, subject_id: int) -> str:
    c = conn()
    row = c.execute("SELECT expires_at FROM memberships WHERE subject_type=? AND subject_id=? AND plan='year'",
                    (subject_type, subject_id)).fetchone()
    c.close()
    return row["expires_at"] if row else ""


def activate_membership(subject_type: str, subject_id: int, days: int = MEMBER_DAYS) -> None:
    """开通/续费会员: 从当前到期时间顺延（未到期续费），否则从现在起算"""
    c = conn()
    from datetime import datetime, timedelta
    row = c.execute("SELECT expires_at FROM memberships WHERE subject_type=? AND subject_id=? AND plan='year'",
                    (subject_type, subject_id)).fetchone()
    base = datetime.now()
    if row:
        try:
            cur = datetime.fromisoformat(row["expires_at"])
            if cur > base:
                base = cur
        except ValueError:
            pass
    expires = (base + timedelta(days=days)).isoformat(timespec="seconds")
    if row:
        c.execute("UPDATE memberships SET expires_at=? WHERE subject_type=? AND subject_id=? AND plan='year'",
                  (expires, subject_type, subject_id))
    else:
        c.execute("INSERT INTO memberships (subject_type, subject_id, plan, expires_at, created_at) VALUES (?,?,?,?,?)",
                  (subject_type, subject_id, "year", expires, _now()))
    c.commit(); c.close()


def create_order(subject_type: str, subject_id: int, amount: int, order_no: str = "", product_id: int = 0) -> str:
    order_no = order_no or f"L{time.strftime('%Y%m%d%H%M%S')}{secrets.token_hex(4).upper()}"
    with conn() as c:
        prod = c.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone() if product_id else None
        snapshot = {"kind": prod["kind"] if prod else "membership", "product_id": product_id, "days": MEMBER_DAYS}
        c.execute("INSERT INTO orders(order_no,subject_type,subject_id,amount,product_id,created_at,snapshot) VALUES(?,?,?,?,?,?,?)", (order_no,subject_type,subject_id,amount,product_id,_now(),json.dumps(snapshot)))
    return order_no


def mark_order_paid(order_no: str, historical_trade_no: str = "", pay_type: str = "") -> Optional[dict]:
    """Keep the legacy order and entitlement grant in one transaction."""
    from datetime import timedelta
    with conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone()
        if not row:
            return None
        if row["status"] == "paid":
            return dict(row)
        if row["jeepay_trade_no"] and row["jeepay_trade_no"] != historical_trade_no:
            return None
        snapshot = json.loads(row["snapshot"] or "{}")
        if not snapshot:
            prod = c.execute("SELECT * FROM products WHERE id=?", (row["product_id"],)).fetchone()
            if row["product_id"] and not prod:
                return None
            snapshot = {"kind": prod["kind"] if prod else "membership", "product_id": row["product_id"], "days": MEMBER_DAYS}
        if snapshot["kind"] == "pack":
            c.execute("INSERT OR IGNORE INTO purchases(subject_type,subject_id,product_id) VALUES(?,?,?)", (row["subject_type"],row["subject_id"],snapshot["product_id"]))
        elif snapshot["kind"] == "membership":
            membership = c.execute("SELECT expires_at FROM memberships WHERE subject_type=? AND subject_id=? AND plan='year'", (row["subject_type"],row["subject_id"])).fetchone()
            base = datetime.now()
            if membership:
                try:
                    base = max(base, datetime.fromisoformat(membership["expires_at"]))
                except ValueError:
                    pass
            expiry = (base + timedelta(days=snapshot.get("days", MEMBER_DAYS))).isoformat(timespec="seconds")
            c.execute("INSERT INTO memberships(subject_type,subject_id,plan,expires_at,created_at) VALUES(?,?,'year',?,?) ON CONFLICT(subject_type,subject_id,plan) DO UPDATE SET expires_at=excluded.expires_at", (row["subject_type"],row["subject_id"],expiry,_now()))
        else:
            return None
        c.execute("UPDATE orders SET status='paid',jeepay_trade_no=?,pay_type=?,paid_at=?,snapshot=? WHERE order_no=?", (historical_trade_no,pay_type,_now(),json.dumps(snapshot),order_no))
        return dict(c.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone())


def get_order(order_no: str) -> Optional[dict]:
    c = conn()
    row = c.execute("SELECT * FROM orders WHERE order_no=?", (order_no,)).fetchone()
    c.close()
    return dict(row) if row else None


# ---------------- Daily limit ----------------

def check_and_count_play(uid: int, is_super: bool) -> tuple[bool, str]:
    if is_super:
        return True, ""
    c = conn()
    today = date.today().isoformat()
    u = c.execute("SELECT daily_count, last_play_date FROM users WHERE id=?", (uid,)).fetchone()
    if u["last_play_date"] != today:
        c.execute("UPDATE users SET daily_count=0, last_play_date=? WHERE id=?", (today, uid))
        u = c.execute("SELECT daily_count FROM users WHERE id=?", (uid,)).fetchone()
    if u["daily_count"] >= DAILY_LIMIT:
        c.close()
        return False, f"今日次数已用完（上限 {DAILY_LIMIT} 次），明天再来～"
    c.execute("UPDATE users SET daily_count = daily_count + 1 WHERE id=?", (uid,))
    c.commit(); c.close()
    return True, ""


def log_play(uid: int, template_id: Optional[int], result: str, tpl_title: str = "") -> None:
    c = conn()
    c.execute("INSERT INTO play_log (user_id, template_id, result, tpl_title, played_at) VALUES (?,?,?,?,?)",
              (uid, template_id, result, tpl_title or "", _now()))
    c.commit(); c.close()


def _migrate_play_log() -> None:
    """play_log 加 tpl_title 列(幂等)"""
    c = conn()
    cols = {r[1] for r in c.execute("PRAGMA table_info(play_log)")}
    if "tpl_title" not in cols:
        c.execute("ALTER TABLE play_log ADD COLUMN tpl_title TEXT DEFAULT ''")
    c.commit(); c.close()



def list_play_history(uid: int, limit: int = 50) -> list[dict]:
    """用户的抽奖历史(倒序)"""
    c = conn()
    rows = c.execute(
        "SELECT id, template_id, tpl_title, result, played_at FROM play_log "
        "WHERE user_id=? ORDER BY id DESC LIMIT ?", (uid, limit)).fetchall()
    c.close()
    return [dict(r) for r in rows]


GUEST_DEMO_POOL = [
    {"name": "幸运小礼物", "category": "common", "weight": 40},
    {"name": "惊喜福签", "category": "rare", "weight": 25},
    {"name": "超级大奖", "category": "epic", "weight": 8},
    {"name": "传说·神秘礼盒", "category": "legend", "weight": 2},
    {"name": "谢谢参与", "category": "common", "weight": 25},
]


def draw_guest_demo(count: int) -> list[dict]:
    """游客演示奖池: 权重随机(无保底/图鉴, 引导注册/开通会员)"""
    names = [p["name"] for p in GUEST_DEMO_POOL]
    weights = [p["weight"] for p in GUEST_DEMO_POOL]
    out = []
    for _ in range(max(1, min(count, 10))):
        name = random.choices(names, weights=weights, k=1)[0]
        meta = next(p for p in GUEST_DEMO_POOL if p["name"] == name)
        out.append({"name": name, "rarity": meta["category"]})
    return out


def log_guest_play(guest_id: int, result: str) -> None:
    """游客抽取流水(记入日志表但用户列置空串规避外键; 单独统计)"""
    c = conn()
    c.execute("INSERT INTO guest_play_log (guest_id, result, played_at) VALUES (?,?,?)",
              (guest_id, result, _now()))
    c.commit(); c.close()


# ---------------- Templates ----------------

DEFAULT_TEMPLATES = [
    {"title": "今日吃什么", "type": T_DISH, "subtitle": "让命运决定今天的胃",
     "rule": "等权随机，绝对公平", "theme": "美食", "positive_title": "今天吃", "negative_title": "",
     "draw_count": 1,
     "items": [{"name": "火锅"}, {"name": "烧烤"}, {"name": "麻辣烫"}, {"name": "螺蛳粉"},
               {"name": "黄焖鸡"}, {"name": "沙拉"}, {"name": "饺子"}, {"name": "日料"},
               {"name": "汉堡"}, {"name": "粥"}]},
    {"title": "幸运抽奖", "type": T_PRIZE, "mode": M_WEIGHTED, "subtitle": "看看今天的手气",
     "rule": "按权重抽取，权重越高概率越大", "theme": "抽奖", "positive_title": "恭喜抽中", "negative_title": "再接再厉",
     "draw_count": 1,
     "items": [{"name": "一等奖", "weight": 1}, {"name": "二等奖", "weight": 2},
               {"name": "三等奖", "weight": 4}, {"name": "谢谢参与", "weight": 8}]},
    {"title": "开会抽人", "type": T_PERSON, "subtitle": "公平点名，拒绝内定",
     "rule": "从名单中随机抽取，可设置一次抽几人", "theme": "点名", "positive_title": "抽到", "negative_title": "",
     "draw_count": 1,
     "items": [{"name": "张三"}, {"name": "李四"}, {"name": "王五"}, {"name": "赵六"},
               {"name": "钱七"}, {"name": "孙八"}]},
]


PREMIUM_TEMPLATES = [
    # 节日主题包 (product: template_festival)
    {"title": "年夜饭抽签", "type": T_DISH, "mode": M_NORMAL, "subtitle": "除夕团圆，好运开席",
     "rule": "等权随机，年夜饭吃什么", "theme": "春节", "positive_title": "今晚就吃", "negative_title": "",
     "draw_count": 1, "product_slug": "template_festival",
     "items": [{"name": "饺子"}, {"name": "红烧肉"}, {"name": "年糕"}, {"name": "火锅"}, {"name": "八宝饭"},
               {"name": "汤圆"}, {"name": "清蒸鱼"}, {"name": "烤鸭"}]},
    {"title": "圣诞惊喜抽奖", "type": T_PRIZE, "mode": M_WEIGHTED, "subtitle": "圣诞夜的大奖",
     "rule": "按权重抽取，圣诞礼物池", "theme": "圣诞", "positive_title": "抽到", "negative_title": "再来一次",
     "draw_count": 1, "product_slug": "template_festival",
     "items": [{"name": "暖心抱枕", "weight": 5, "category": "common"},
               {"name": "热巧克力", "weight": 4, "category": "common"},
               {"name": "圣诞限定徽章", "weight": 2, "category": "rare"},
               {"name": "神秘大礼盒", "weight": 1, "category": "epic"}]},
    # 团建/年会模板包 (product: template_biz)
    {"title": "年会幸运王", "type": T_PRIZE, "mode": M_WEIGHTED, "subtitle": "公司年会，抽大奖",
     "rule": "按权重抽取，大奖现场诞生", "theme": "年会", "positive_title": "恭喜中奖", "negative_title": "明年再战",
     "draw_count": 1, "product_slug": "template_biz",
     "items": [{"name": "阳光普照奖", "weight": 8, "category": "common"},
               {"name": "幸运奖", "weight": 4, "category": "rare"},
               {"name": "三等奖", "weight": 2, "category": "epic"},
               {"name": "特等奖", "weight": 1, "category": "legend"}]},
    {"title": "团建分组点名", "type": T_PERSON, "mode": M_NORMAL, "subtitle": "公平分组，拒绝内定",
     "rule": "从名单随机抽，可一次多人", "theme": "团建", "positive_title": "抽到", "negative_title": "",
     "draw_count": 1, "product_slug": "template_biz",
     "items": [{"name": "一组"}, {"name": "二组"}, {"name": "三组"}, {"name": "四组"},
               {"name": "五组"}, {"name": "六组"}]},
]


def user_entitlements(uid: int) -> dict:
    """返回用户的已购权益: {pack_slugs: set, member: bool}"""
    owned = set(list_purchases("user", uid))
    packs = set()
    for p in list_products():
        if p["kind"] == "pack" and p["id"] in owned:
            packs.add(p["slug"])
    return {"packs": packs, "member": is_member("user", uid)}


def _seed_default_templates(c: sqlite3.Connection, uid: int, *, commit=True) -> None:
    for t in DEFAULT_TEMPLATES:
        cur = c.execute(
            "INSERT INTO templates (owner_id, title, type, mode, subtitle, rule, theme, "
            "positive_title, negative_title, draw_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uid, t["title"], t["type"], t.get("mode", M_NORMAL), t.get("subtitle", ""),
             t.get("rule", ""), t.get("theme", ""), t.get("positive_title", ""),
             t.get("negative_title", ""), t.get("draw_count", 1), _now()),
        )
        tid = cur.lastrowid
        for it in t["items"]:
            c.execute(
                "INSERT INTO items (template_id, name, img, weight, category) VALUES (?,?,?,?,?)",
                (tid, it["name"], it.get("img"), it.get("weight", 1), it.get("category", "")),
            )
    if commit:
        c.commit()


def list_templates(uid: int) -> list[dict]:
    c = conn()
    rows = c.execute("SELECT * FROM templates WHERE owner_id=? ORDER BY id", (uid,)).fetchall()
    out = []
    for t in rows:
        t = dict(t)
        items = [dict(i) for i in c.execute("SELECT * FROM items WHERE template_id=?", (t["id"],)).fetchall()]
        t["items"] = items
        out.append(t)
    c.close()
    return out


def get_template(uid: int, tid: int) -> Optional[dict]:
    c = conn()
    t = c.execute("SELECT * FROM templates WHERE id=? AND owner_id=?", (tid, uid)).fetchone()
    if not t:
        c.close(); return None
    t = dict(t)
    t["items"] = [dict(i) for i in c.execute("SELECT * FROM items WHERE template_id=?", (tid,)).fetchall()]
    c.close()
    return t


def create_template(uid: int, data: dict) -> int:
    c = conn()
    cur = c.execute(
        "INSERT INTO templates (owner_id, title, type, mode, subtitle, rule, theme, "
        "positive_title, negative_title, draw_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (uid, data["title"], data.get("type", T_DISH), data.get("mode", M_NORMAL),
         data.get("subtitle", ""), data.get("rule", ""), data.get("theme", ""),
         data.get("positive_title", ""), data.get("negative_title", ""),
         max(1, int(data.get("draw_count", 1))), _now()),
    )
    tid = cur.lastrowid
    _save_items(c, tid, data.get("items", []))
    c.commit(); c.close()
    return tid


def update_template(uid: int, tid: int, data: dict) -> bool:
    c = conn()
    row = c.execute("SELECT id FROM templates WHERE id=? AND owner_id=?", (tid, uid)).fetchone()
    if not row:
        c.close(); return False
    c.execute(
        "UPDATE templates SET title=?, type=?, mode=?, subtitle=?, rule=?, theme=?, "
        "positive_title=?, negative_title=?, draw_count=?, machine=? WHERE id=?",
        (data["title"], data.get("type", T_DISH), data.get("mode", M_NORMAL),
         data.get("subtitle", ""), data.get("rule", ""), data.get("theme", ""),
         data.get("positive_title", ""), data.get("negative_title", ""),
         max(1, int(data.get("draw_count", 1))),
         data.get("machine") or MACHINE_DEFAULT, tid),
    )
    c.execute("DELETE FROM items WHERE template_id=?", (tid,))
    _save_items(c, tid, data.get("items", []))
    c.commit(); c.close()
    return True


def delete_template(uid: int, tid: int) -> bool:
    c = conn()
    row = c.execute("SELECT id FROM templates WHERE id=? AND owner_id=?", (tid, uid)).fetchone()
    if not row:
        c.close(); return False
    c.execute("DELETE FROM templates WHERE id=?", (tid,))
    c.commit(); c.close()
    return True


def _save_items(c: sqlite3.Connection, tid: int, items: list) -> None:
    for it in items:
        name = (it.get("name") or "").strip()
        if not name:
            continue
        c.execute(
            "INSERT INTO items (template_id, name, img, weight, category) VALUES (?,?,?,?,?)",
            (tid, name, it.get("img"), max(1, int(it.get("weight", 1))), it.get("category", "")),
        )


# ---------------- Draw engine ----------------

def draw(tpl: dict, history: set) -> list[str]:
    """Return list of drawn names per template type + mode."""
    items = [i for i in tpl["items"] if (i.get("name") or "").strip()]
    if not items:
        return []
    ttype = tpl.get("type", T_DISH)
    mode = tpl.get("mode", M_NORMAL)
    n = max(1, int(tpl.get("draw_count", 1)))

    if ttype == T_PERSON:
        pool = [i["name"] for i in items if i["name"] not in history]
        if len(pool) < n:
            pool = [i["name"] for i in items]  # fallback if history too large
        return random.sample(pool, min(n, len(pool)))

    if mode == M_WEIGHTED:
        total = sum(max(1, int(i.get("weight", 1))) for i in items)
        out = []
        chosen = set()
        for _ in range(min(n, len(items))):
            r = random.uniform(0, total)
            for i in items:
                if i["name"] in chosen:
                    continue
                r -= max(1, int(i.get("weight", 1)))
                if r <= 0:
                    out.append(i["name"]); chosen.add(i["name"]); break
            else:
                for i in items:
                    if i["name"] not in chosen:
                        out.append(i["name"]); chosen.add(i["name"]); break
        return out

    # normal / no_repeat -> equal weight
    pool = [i["name"] for i in items if i["name"] not in history] if mode == M_NO_REPEAT else [i["name"] for i in items]
    if not pool:
        pool = [i["name"] for i in items]
    return random.sample(pool, min(n, len(pool)))


# ---------------- Superadmin ----------------

def list_all_users() -> list[dict]:
    c = conn()
    rows = c.execute("SELECT * FROM users ORDER BY id").fetchall()
    c.close()
    return [user_public(dict(r)) for r in rows]


def search_users(query: str = "", status: str = "", page: int = 1, page_size: int = 25) -> dict:
    """Bounded account listing for the operations console."""
    filters = []
    params = []
    if query:
        filters.append("(instr(lower(custom_id),lower(?))>0 OR instr(lower(email),lower(?))>0 OR instr(phone,?)>0 OR id=?)")
        params.extend((query, query, query, int(query) if query.isdigit() else -1))
    if status:
        filters.append("status=?")
        params.append(status)
    where = " WHERE " + " AND ".join(filters) if filters else ""
    with conn() as c:
        total = c.execute("SELECT COUNT(*) FROM users" + where, params).fetchone()[0]
        pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, pages)
        rows = c.execute("SELECT * FROM users" + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
                         (*params, page_size, (page - 1) * page_size)).fetchall()
    return {"users": [user_public(dict(row)) for row in rows], "total": total,
            "page": page, "page_size": page_size, "pages": pages}


def set_user_status(uid: int, status: str, actor_id: int | None = None, reason: str = "管理员操作") -> bool:
    if status not in ("active", "disabled", "banned"):
        return False
    with conn() as c:
        c.execute("BEGIN IMMEDIATE")
        target = c.execute("SELECT id,role,status FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            return False
        if target["status"] == status:
            return True
        if status != "active" and actor_id == uid:
            return False
        if status != "active" and target["role"] == "superadmin":
            active_admins = c.execute("SELECT COUNT(*) FROM users WHERE role='superadmin' AND status='active'").fetchone()[0]
            if active_admins <= 1:
                return False
        c.execute("UPDATE users SET status=? WHERE id=?", (status, uid))
        if status != "active":
            c.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        if actor_id is not None:
            c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
                      (actor_id, "user_status", f"user:{uid}", json.dumps({"before": target["status"], "after": status, "reason": reason.strip()}, ensure_ascii=False), _now()))
        return True


# ================= Game layer: rarity / pity / collection =================

# 稀有度四档：普通/稀有/史诗/传说。item.category 存稀有度（空=自动分配）
RARITIES = ["common", "rare", "epic", "legendary"]
RARITY_META = {
    "common":    {"label": "普通", "color": "#9aa7b0", "emoji": "⚪"},
    "rare":      {"label": "稀有", "color": "#38bdf8", "emoji": "🔵"},
    "epic":      {"label": "史诗", "color": "#a78bfa", "emoji": "🟣"},
    "legendary": {"label": "传说", "color": "#fcd34d", "emoji": "🟠"},
}
# 自动分配比例: 大多数普通，少量高稀有
_RARITY_AUTO = (["common"] * 70 + ["rare"] * 20 + ["epic"] * 8 + ["legendary"] * 2)

PITY_EPIC = 20     # 连续 N 抽不出史诗/传说 → 必出史诗
PITY_LEGEND = 60   # 连续 N 抽不出传说 → 必出传说

MACHINE_DEFAULT = "capsule"   # capsule|slot|egg|card|wheel


def _migrate(c: sqlite3.Connection) -> None:
    """Additive migration for the game layer. Idempotent."""
    cols_t = {r[1] for r in c.execute("PRAGMA table_info(templates)")}
    if "machine" not in cols_t:
        c.execute("ALTER TABLE templates ADD COLUMN machine TEXT NOT NULL DEFAULT '%s'" % MACHINE_DEFAULT)
    cols_i = {r[1] for r in c.execute("PRAGMA table_info(items)")}
    if "category" not in cols_i:
        c.execute("ALTER TABLE items ADD COLUMN category TEXT DEFAULT ''")
    cols_u = {r[1] for r in c.execute("PRAGMA table_info(users)")}
    if "coins" not in cols_u:
        c.execute("ALTER TABLE users ADD COLUMN coins INTEGER NOT NULL DEFAULT 0")
    if "reg_ip" not in cols_u:
        c.execute("ALTER TABLE users ADD COLUMN reg_ip TEXT NOT NULL DEFAULT ''")
    if "must_change_password" not in cols_u:
        c.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS pity (
            user_id INTEGER NOT NULL,
            template_id INTEGER NOT NULL,
            since_epic INTEGER NOT NULL DEFAULT 0,
            since_legend INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, template_id)
        );
        CREATE TABLE IF NOT EXISTS collection (
            user_id INTEGER NOT NULL,
            item_id INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 1,
            first_at TEXT NOT NULL,
            PRIMARY KEY (user_id, item_id)
        );
        """
    )
    # Keep legacy values unchanged. Empty category already resolves to common;
    # booting or upgrading must not silently invent a different prize rarity.
    c.commit()


def _ensure_migrated() -> None:
    c = conn()
    _migrate(c)
    c.close()


def rarity_of(item: dict) -> str:
    cat = (item.get("category") or "").strip().lower()
    return cat if cat in RARITY_META else "common"


def get_pity(uid: int, tid: int) -> dict:
    c = conn()
    row = c.execute("SELECT * FROM pity WHERE user_id=? AND template_id=?", (uid, tid)).fetchone()
    c.close()
    return dict(row) if row else {"since_epic": 0, "since_legend": 0}


def _bump_pity(c: sqlite3.Connection, uid: int, tid: int, rar: str) -> dict:
    row = c.execute("SELECT * FROM pity WHERE user_id=? AND template_id=?", (uid, tid)).fetchone()
    se, sl = (row["since_epic"], row["since_legend"]) if row else (0, 0)
    hit_epic = hit_legend = False
    if rar in ("epic", "legendary"):
        se = 0
    elif PITY_EPIC - se <= 1:
        rar, se, hit_epic = "epic", 0, True
    else:
        se += 1
    if rar == "legendary":
        sl = 0
    elif PITY_LEGEND - sl <= 1:
        rar, se, sl = "legendary", 0, 0
        hit_epic = False
        hit_legend = True
    else:
        sl += 1
    c.execute(
        "INSERT INTO pity (user_id,template_id,since_epic,since_legend) VALUES (?,?,?,?) "
        "ON CONFLICT(user_id,template_id) DO UPDATE SET since_epic=?, since_legend=?",
        (uid, tid, se, sl, se, sl))
    return {"rarity": rar, "pity_hit_epic": hit_epic, "pity_hit_legend": hit_legend}


def draw_game(uid: int, tpl: dict, n: int = 1) -> list[dict]:
    """Game draw with rarity + pity. Returns [{name, rarity, pity_hit}]. Only for prize type."""
    items = [i for i in tpl["items"] if (i.get("name") or "").strip()]
    if not items:
        return []
    out = []
    c = conn()
    try:
        for _ in range(max(1, min(n, 20))):
            pick = random.choices(items, weights=[max(1, int(i.get("weight", 1))) for i in items], k=1)[0]
            info = _bump_pity(c, uid, tpl["id"], rarity_of(pick))
            name = pick["name"]
            if info["pity_hit_epic"] or info["pity_hit_legend"]:
                # 保底命中：强制从对应稀有度池里挑一个（权重高者优先）
                want = "legendary" if info["pity_hit_legend"] else "epic"
                pool = [i for i in items if rarity_of(i) == want]
                if pool:
                    pick = random.choices(pool, weights=[max(1, int(i.get("weight", 1))) for i in pool], k=1)[0]
                    name = pick["name"]
            c.execute("INSERT INTO collection (user_id,item_id,count,first_at) VALUES (?,?,1,?) "
                      "ON CONFLICT(user_id,item_id) DO UPDATE SET count=count+1",
                      (uid, pick["id"], _now()))
            out.append({"name": name, "rarity": info["rarity"], "id": pick["id"],
                        "pity_hit_epic": info["pity_hit_epic"], "pity_hit_legend": info["pity_hit_legend"]})
        c.commit()
    finally:
        c.close()
    return out


def get_collection(uid: int, tid: int) -> list[dict]:
    c = conn()
    rows = c.execute(
        "SELECT i.id, i.name, i.category AS rarity, COALESCE(col.count,0) AS count, col.first_at "
        "FROM items i LEFT JOIN collection col ON col.item_id=i.id AND col.user_id=? "
        "WHERE i.template_id=? ORDER BY i.id", (uid, tid)).fetchall()
    c.close()
    return [dict(r) for r in rows]



def _ensure_settings_table() -> None:
    c = conn()
    c.execute("""CREATE TABLE IF NOT EXISTS settings (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
    )""")
    c.commit()
    c.close()



def get_setting(key: str, default: str = "") -> str:
    c = conn()
    row = c.execute("SELECT v FROM settings WHERE k=?", (key,)).fetchone()
    c.close()
    return row["v"] if row else default


def set_setting(key: str, value: str) -> None:
    c = conn()
    c.execute("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (key, value))
    c.commit()
    c.close()


def _ensure_feedback_table() -> None:
    c = conn()
    c.execute("""CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )""")
    cols = {r[1] for r in c.execute("PRAGMA table_info(feedback)")}
    if "priority" not in cols:
        c.execute("ALTER TABLE feedback ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
    c.commit()
    c.close()



def add_feedback(subject_type: str, subject_id: int, content: str, priority: int = 0) -> None:
    c = conn()
    c.execute("INSERT INTO feedback(subject_type,subject_id,content,priority) VALUES(?,?,?,?)",
              (subject_type, subject_id, content, priority))
    c.commit()
    c.close()


def list_feedback(limit: int = 100) -> list:
    c = conn()
    rows = c.execute("SELECT * FROM feedback ORDER BY priority DESC, id DESC LIMIT ?", (limit,)).fetchall()
    c.close()
    return [dict(r) for r in rows]


# ================= 内容商城 (v4) =================
def _ensure_shop_tables() -> None:
    c = conn()
    c.execute("""CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        price_cents INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'pack',        -- pack=模板包, membership=内容年卡
        desc TEXT DEFAULT '',
        cover TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'paid',
        purchased_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(subject_type, subject_id, product_id)
    )""")
    # orders 表加 product_id 列(幂等迁移): 0/空=传统会员订单, >0=内容商品订单
    ocols = {r[1] for r in c.execute("PRAGMA table_info(orders)")}
    if "snapshot" not in ocols:
        c.execute("ALTER TABLE orders ADD COLUMN snapshot TEXT NOT NULL DEFAULT '{}'")
    if "product_id" not in ocols:
        c.execute("ALTER TABLE orders ADD COLUMN product_id INTEGER NOT NULL DEFAULT 0")
    c.commit()
    c.close()



# ================= 名单库 (v4.2) =================
def _ensure_lists_tables() -> None:
    c = conn()
    c.execute("""CREATE TABLE IF NOT EXISTS name_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        items TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now','localtime'))
    )""")
    c.commit()
    c.close()



def create_name_list(uid: int, title: str, items: list) -> int:
    c = conn()
    names = []
    for i in items:
        name = (i if isinstance(i, str) else (i.get("name") or "")).strip()
        if name:
            names.append(name)
    cur = c.execute(
        "INSERT INTO name_lists (owner_id, title, items) VALUES (?,?,?)",
        (uid, title, json.dumps(names, ensure_ascii=False)),
    )
    c.commit(); c.close()
    return cur.lastrowid


def list_name_lists(uid: int) -> list[dict]:
    c = conn()
    rows = c.execute("SELECT * FROM name_lists WHERE owner_id=? ORDER BY id DESC", (uid,)).fetchall()
    c.close()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["items"] = json.loads(d.get("items") or "[]")
        except Exception:
            d["items"] = []
        out.append(d)
    return out


def delete_name_list(uid: int, lid: int) -> bool:
    c = conn()
    cur = c.execute("DELETE FROM name_lists WHERE id=? AND owner_id=?", (lid, uid))
    c.commit(); c.close()
    return cur.rowcount > 0


# 分组玩法: 一次把名单随机均分为 groups 组
def draw_groups(names: list[str], groups: int) -> list[list[str]]:
    """随机打乱名单并均分到 groups 组, 每组人数尽量均匀。"""
    pool = [x for x in names if (x or "").strip()]
    if not 2 <= groups <= len(pool):
        raise ValueError("组数必须在 2 和人数之间")
    secrets.SystemRandom().shuffle(pool)
    return [pool[i::groups] for i in range(groups)]



def init_default_products() -> None:
    """预置默认商品。存在则跳过。"""
    c = conn()
    defaults = [
        # slug, name, price_cents, kind, desc, cover, sort
        ("template_festival", "节日主题包", 990, "pack",
         "春节/圣诞/婚礼等节日限定机台主题", "🎉", 1),
        ("template_biz", "团建/年会模板包", 1990, "pack",
         "企业团建/年会高级机台模板", "🎪", 2),
        ("membership_year", "内容年卡", 9900, "membership",
         "解锁全部内容模板 + 自定义机台 Pro + 云保存(365天)", "👑", 3),
    ]
    for slug, name, price, kind, desc, cover, sort in defaults:
        exists = c.execute("SELECT id FROM products WHERE slug=?", (slug,)).fetchone()
        if not exists:
            c.execute(
                "INSERT INTO products(slug,name,price_cents,kind,desc,cover,sort) VALUES(?,?,?,?,?,?,?)",
                (slug, name, price, kind, desc, cover, sort))
    c.commit()
    c.close()



def list_products() -> list:
    c = conn()
    rows = c.execute("SELECT * FROM products WHERE active=1 ORDER BY sort, id").fetchall()
    c.close()
    return [dict(r) for r in rows]


def get_product(slug: str) -> Optional[dict]:
    c = conn()
    row = c.execute("SELECT * FROM products WHERE slug=? AND active=1", (slug,)).fetchone()
    c.close()
    return dict(row) if row else None


def get_product_by_id(pid: int) -> Optional[dict]:
    c = conn()
    row = c.execute("SELECT * FROM products WHERE id=? AND active=1", (pid,)).fetchone()
    c.close()
    return dict(row) if row else None


def has_purchase(subject_type: str, subject_id: int, product_id: int) -> bool:
    c = conn()
    row = c.execute(
        "SELECT id FROM purchases WHERE subject_type=? AND subject_id=? AND product_id=?",
        (subject_type, subject_id, product_id)).fetchone()
    c.close()
    return row is not None


def record_purchase(subject_type: str, subject_id: int, product_id: int) -> None:
    c = conn()
    c.execute(
        "INSERT OR IGNORE INTO purchases(subject_type,subject_id,product_id) VALUES(?,?,?)",
        (subject_type, subject_id, product_id))
    c.commit()
    c.close()


def list_purchases(subject_type: str, subject_id: int) -> list:
    c = conn()
    rows = c.execute(
        "SELECT product_id FROM purchases WHERE subject_type=? AND subject_id=? AND status='paid'",
        (subject_type, subject_id)).fetchall()
    c.close()
    return [r["product_id"] for r in rows]


def create_session(uid: int) -> str:
    token = secrets.token_urlsafe(32)
    with conn() as c:
        c.execute("DELETE FROM sessions WHERE expires_at<?", (int(time.time()),))
        c.execute("INSERT INTO sessions VALUES (?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), uid, int(time.time()) + 7*86400))
    return token


def session_user(token: str) -> Optional[int]:
    if not token:
        return None
    with conn() as c:
        row = c.execute("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?", (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
    return row["user_id"] if row else None


def delete_session(token: str) -> None:
    with conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
