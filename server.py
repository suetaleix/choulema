"""FastAPI backend for the 3D lottery platform."""
from __future__ import annotations

import os
import secrets
import re
import time
from contextlib import asynccontextmanager
from collections import defaultdict, deque
from threading import Lock
from typing import Optional
from urllib.parse import urlparse, parse_qsl, urlencode
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, Response, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from request_security import SecurityBoundaryMiddleware, trusted_mutation

import db
import email_auth

@asynccontextmanager
async def lifespan(app):
    if os.getenv('LOTTERY_ENV') == 'production':
        from v7_release import preflight
        report = preflight()
        if not report['ok']:
            raise RuntimeError('Production preflight failed: ' + '; '.join(report['errors']))
    db.init_db()
    v6_engine.init_schema()
    v6_payments.init_schema()
    v7_referrals.init_schema()
    v7_entitlements.init_schema()
    v7_operations.init_schema()
    v7_operations.startup_recovery()
    yield


app = FastAPI(lifespan=lifespan)


@app.get('/healthz')
def healthz():
    from v7_release import health
    report = health(db.DB_PATH)
    return JSONResponse(report, status_code=200 if report['status'] == 'ok' else 503,
                        headers={'Cache-Control': 'no-store'})


def _secure_cookie() -> bool:
    return os.getenv("LOTTERY_PUBLIC_URL", "").startswith("https://")


# ---- simple in-memory rate limiter (per client IP) ----
_RATE = defaultdict(deque)  # ip -> deque of timestamps
_RATE_WINDOW = 60          # seconds
_RATE_MAX = 120            # max requests per window for /api/play and /api/login (游戏化连抽友好)
_LOGIN_FAIL = defaultdict(deque)   # ip -> 失败时间戳
_LOGIN_LOCK = 600                  # 锁定窗口10分钟
_LOGIN_FAIL_MAX = 5                # 窗口内最大失败次数
_PATH_LIMITS = {"/api/play": 120, "/api/login": 120, "/api/draw": 120,
                "/api/captcha": 20, "/api/register": 10, "/api/password/change": 10,
                "/api/register/email-code": 6,
                "/api/qr": 30, "/api/feedback": 10, "/api/v6/import": 10,
                "/api/v6/runs": 30, "/api/v6/checkout": 10, "/api/v6/cards/redeem": 10,
                "/api/v7/referrals/visit": 20, "/api/v7/events": 30}
_LIMITED_PATHS = set(_PATH_LIMITS)
_RATE_BUCKET_CAP = 10000


def _prune_rate_buckets(buckets, now, window):
    for key, queue in list(buckets.items()):
        if not queue or now - queue[-1] > window:
            buckets.pop(key, None)


@app.middleware("http")
async def guest_cookie(request: Request, call_next):
    """未带游客cookie的请求自动发一个(免登录直接可玩)"""
    # Establish identity on the document response before its parallel API calls.
    # Otherwise the first captcha/public/referral responses can overwrite each
    # other's fresh guest cookie and strand the referral on a different guest.
    path = request.url.path
    if not request.cookies.get(GUEST_COOKIE) and (path.startswith("/api/") or path == "/" or path.endswith(".html")):
        gk = secrets.token_hex(16)
        request.state.new_gk = gk
        response = await call_next(request)
        if not getattr(request.state, "guest_cookie_rotated", False):
            response.set_cookie(GUEST_COOKIE, gk, max_age=365 * 86400, httponly=True, samesite="lax", secure=_secure_cookie())
        return response
    return await call_next(request)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    path = request.url.path
    if path in _LIMITED_PATHS:
        ip = request.client.host if request.client else "?"
        now = time.time()
        if len(_RATE) >= _RATE_BUCKET_CAP:
            _prune_rate_buckets(_RATE, now, _RATE_WINDOW)
            if (ip, path) not in _RATE and len(_RATE) >= _RATE_BUCKET_CAP:
                return JSONResponse(status_code=429, content={"error": "请求过于频繁，请稍后再试"})
        dq = _RATE[(ip, path)]
        while dq and now - dq[0] > _RATE_WINDOW:
            dq.popleft()
        maximum = _PATH_LIMITS[path]
        if len(dq) >= maximum:
            return JSONResponse(status_code=429, content={"error": "请求过于频繁，请稍后再试"})
        dq.append(now)
    # 登录防爆破: 同IP失败5次锁10分钟
    if path == "/api/login" and request.method == "POST":
        ip = request.client.host if request.client else "?"
        now = time.time()
        if len(_LOGIN_FAIL) >= _RATE_BUCKET_CAP:
            _prune_rate_buckets(_LOGIN_FAIL, now, _LOGIN_LOCK)
            if ip not in _LOGIN_FAIL and len(_LOGIN_FAIL) >= _RATE_BUCKET_CAP:
                return JSONResponse(status_code=429, content={"error": "请求过于频繁，请稍后再试"})
        fq = _LOGIN_FAIL[ip]
        while fq and now - fq[0] > _LOGIN_LOCK:
            fq.popleft()
        if len(fq) >= _LOGIN_FAIL_MAX:
            return JSONResponse(status_code=429, content={"error": "失败次数过多，请 10 分钟后再试"})
    return await call_next(request)


@app.middleware("http")
async def response_cache_policy(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "private, no-store"
    elif path == "/" or path.endswith(".html") or path.startswith(("/v6/", "/v7/")):
        # These filenames remain stable across releases; revalidate before reuse.
        response.headers["Cache-Control"] = "no-cache"
    return response

_CAPTCHAS: dict[str, tuple[str, float]] = {}  # captcha_id -> (code, expire_ts)
_CAPTCHA_TTL = 300  # 5分钟有效
_CAPTCHA_CAP = 2048
_CAPTCHA_LOCK = Lock()
GUEST_COOKIE = "gk"
CUSTOM_ID_RE = re.compile(r"^[a-zA-Z0-9]+$")

def get_guest_key(req: Request) -> str:
    return req.cookies.get(GUEST_COOKIE) or getattr(req.state, "new_gk", "")


def guest_identity(req: Request):
    """返回 (subject_type, subject_id, guest_key) — 未登录游客身份"""
    gk = get_guest_key(req)
    if not gk:
        return None
    g = db.get_or_create_guest(gk)
    return ("guest", g["id"], gk)


def current_subject(req: Request):
    """统一身份: 优先登录用户, 否则游客。返回 dict(kind, id, member, gk)"""
    tok = get_token(req)
    if tok and (uid := db.session_user(tok)):
        u = db.get_user(uid)
        if u and u["status"] == "active":
            member = db.is_member("user", u["id"]) or u["role"] == "superadmin"
            return {"kind": "user", "id": u["id"], "member": member, "gk": "", "user": u}
    ident = guest_identity(req)
    if ident:
        member = db.is_member("guest", ident[1])
        return {"kind": "guest", "id": ident[1], "member": member, "gk": ident[2], "user": None}
    return None


def _cfg_int(key: str, default: int) -> int:
    try:
        return int(db.get_setting(key, str(default)))
    except (TypeError, ValueError):
        return default


def _guest_daily_limit() -> int:
    return _cfg_int("guest_daily_limit", db.GUEST_DAILY_LIMIT)


def _ip_daily_limit() -> int:
    return _cfg_int("ip_daily_limit", db.IP_GUEST_DAILY_LIMIT)


def _member_price_cents() -> int:
    return _cfg_int("member_price_cents", db.MEMBER_PRICE_CENTS)


def _reg_open() -> bool:
    return db.get_setting("registration_open", "1") == "1"



def check_quota(subj: dict):
    """统一配额: v4 起抽奖完全免费无限次。仅校验账号状态,不做次数限制。
    返回 (ok, msg, remaining), remaining 恒为 -1(无限)。
    保留 check_and_count_* 调用以兼容历史日志,但不再阻止抽取。"""
    if subj["kind"] == "user":
        u = subj["user"]
        if u["role"] == "superadmin":
            return True, "", -1
        if u["status"] != "active":
            return False, "账号已被禁用", 0
        db.check_and_count_play(u["id"], False)  # 仅计数,不再限次
        return True, "", -1
    # guest
    db.check_and_count_guest(subj["gk"])  # 仅计数,不再限次
    return True, "", -1


def _err(code: int, msg: str):
    return JSONResponse(status_code=code, content={"error": msg})


def get_token(req: Request) -> Optional[str]:
    return req.cookies.get("sid") or req.headers.get("Authorization", "").replace("Bearer ", "") or None


def current_user(req: Request, allow_password_change: bool = False):
    tok = get_token(req)
    if not tok or not (uid := db.session_user(tok)):
        raise HTTPException(status_code=401, detail="未登录")
    u = db.get_user(uid)
    if not u:
        raise HTTPException(status_code=401, detail="用户不存在")
    if u["status"] != "active":
        raise HTTPException(status_code=403, detail="账号已被禁用")
    if u.get("must_change_password") and not allow_password_change:
        raise HTTPException(status_code=403, detail="请先修改临时密码")
    return u


@app.middleware("http")
async def require_password_change(request: Request, call_next):
    path = request.url.path
    allowed = {"/api/login", "/api/logout", "/api/me", "/api/password/change", "/api/v7/public"}
    if path.startswith("/api/") and path not in allowed:
        token = get_token(request)
        uid = db.session_user(token) if token else None
        user = db.get_user(uid) if uid else None
        if user and user.get("must_change_password"):
            return JSONResponse(status_code=403, content={"error": "请先修改临时密码", "must_change_password": True})
    return await call_next(request)


@app.middleware("http")
async def same_origin_mutation(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path != "/api/v6/payment/notify":
        if not trusted_mutation(request):
            return JSONResponse(status_code=403, content={"error": "请求来源不匹配"})
    return await call_next(request)


app.add_middleware(SecurityBoundaryMiddleware)


# ---------------- Auth ----------------
class RegisterIn(BaseModel):
    email: str = Field(default="", max_length=254)
    custom_id: str = Field(default="", max_length=32)
    password: str = Field(max_length=128)
    challenge_id: str = Field(default="", max_length=64)
    email_code: str = Field(default="", max_length=16)


class EmailCodeIn(BaseModel):
    email: str = Field(max_length=254)


class LoginIn(BaseModel):
    identifier: str = Field(default="", max_length=254)
    phone: str = Field(default="", max_length=64)  # Compatibility with existing clients.
    password: str = Field(max_length=128)


def _gen_captcha() -> tuple[str, str, bytes]:
    """生成4位验证码: 返回(id, code, png_bytes)"""
    import io, random as _r
    from PIL import Image, ImageDraw, ImageFont
    chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # 去掉易混淆的0/1/I/L
    code = "".join(secrets.choice(chars) for _ in range(4))
    cid = secrets.token_hex(8)
    w, h = 120, 44
    img = Image.new("RGB", (w, h), (245, 247, 250))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
    except Exception:
        font = ImageFont.load_default()
    for i, ch in enumerate(code):
        x = 10 + i * 27 + _r.randint(-2, 2)
        y = 5 + _r.randint(-3, 3)
        d.text((x, y), ch, fill=(_r.randint(20,120), _r.randint(20,120), _r.randint(120,200)), font=font)
    for _ in range(4):  # 干扰线
        d.line([(_r.randint(0,w), _r.randint(0,h)), (_r.randint(0,w), _r.randint(0,h))], fill=(_r.randint(120,200),)*3, width=1)
    for _ in range(60):  # 噪点
        d.point((_r.randint(0,w), _r.randint(0,h)), fill=(_r.randint(0,200),)*3)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    with _CAPTCHA_LOCK:
        now = time.time()
        for old_id, (_, expires) in list(_CAPTCHAS.items()):
            if expires <= now:
                _CAPTCHAS.pop(old_id, None)
        if len(_CAPTCHAS) >= _CAPTCHA_CAP:
            raise HTTPException(status_code=429, detail="验证码请求较多，请稍后重试")
        _CAPTCHAS[cid] = (code, now + _CAPTCHA_TTL)
    return cid, code, buf.getvalue()


@app.get("/api/captcha")
def api_captcha():
    """图形验证码: 返回 {id, image(dataURL)}"""
    import base64
    cid, _code, png = _gen_captcha()
    return {"id": cid, "image": "data:image/png;base64," + base64.b64encode(png).decode()}


def _check_captcha(cid: str, ans: str) -> bool:
    """校验并销毁(一次性)"""
    with _CAPTCHA_LOCK:
        item = _CAPTCHAS.pop(cid, None) if cid else None
    if not item:
        return False
    code, exp = item
    if time.time() > exp:
        return False
    return ans.strip().upper() == code


@app.post('/api/register/email-code')
def api_registration_email(r: EmailCodeIn, req: Request):
    v7_operations.ensure_available()
    if not _reg_open():
        return _err(403, '注册已暂时关闭，请联系管理员')
    ip = req.client.host if req.client else '?'
    if db.count_registrations_today(ip) >= _cfg_int('register_per_ip_daily', 3):
        return _err(429, '该网络今日注册人数已达上限')
    try:
        return email_auth.request_code(r.email, ip)
    except email_auth.EmailError as error:
        return JSONResponse({'error': str(error), 'retry_after': error.retry_after}, status_code=error.status,
                            headers={'Retry-After': str(error.retry_after)} if error.retry_after else {})


@app.post("/api/register")
def api_register(r: RegisterIn, req: Request):
    v7_operations.ensure_available()
    if not _reg_open():
        return _err(403, "注册已暂时关闭，请联系管理员")
    try:
        email = email_auth.normalize_email(r.email)
    except email_auth.EmailError as error:
        return _err(400, str(error))
    ip = req.client.host if req.client else "?"
    max_reg = _cfg_int("register_per_ip_daily", 3)
    if db.count_registrations_today(ip) >= max_reg:
        return _err(429, "该网络今日注册人数已达上限")
    custom_id = r.custom_id or 'u' + secrets.token_hex(6)
    if not CUSTOM_ID_RE.fullmatch(custom_id) or len(custom_id) < 2:
        return _err(400, "自定义ID只能是字母数字，至少2位")
    if len(r.password) < 8:
        return _err(400, "密码至少8位")
    guest = guest_identity(req)
    def before_create(c):
        v7_operations.ensure_new_work(c)
        if not _reg_open():
            raise HTTPException(403, '注册已暂时关闭，请联系管理员')
        count = c.execute('SELECT COUNT(*) FROM users WHERE reg_ip=? AND created_at>=?', (ip, db._now()[:10])).fetchone()[0]
        if count >= max_reg:
            raise HTTPException(429, '该网络今日注册人数已达上限')
        return email_auth.consume_code(c, email, r.challenge_id, r.email_code.strip())
    # Account creation and referral rewards commit together. A failed grant
    # cannot leave a registered account with silently lost attribution.
    def registered(c,uid):
        # Check again inside the account transaction in case maintenance started
        # after email verification. An exception rolls the new account back.
        v7_operations.ensure_new_work(c)
        v7_referrals.register_created(c,uid,guest[1] if guest else None)
    ok, msg = db.create_user(None, custom_id, r.password, reg_ip=ip, on_created=registered,
                             email=email, before_create=before_create)
    if not ok:
        return _err(400, msg)
    return {"success": True}


@app.post("/api/login")
def api_login(r: LoginIn, req: Request):
    u = db.authenticate(r.identifier or r.phone, r.password)
    if not u:
        ip = req.client.host if req.client else "?"
        _LOGIN_FAIL[ip].append(time.time())
        return _err(401, "邮箱、账号 ID 或密码错误")
    if u["status"] != "active":
        return _err(403, "账号已被禁用")
    tok = db.create_session(u["id"])
    guest = guest_identity(req)
    previous = current_subject(req)
    handoff = None
    if guest and previous and previous["kind"] == "guest":
        with db.conn() as c:
            c.execute("BEGIN IMMEDIATE")
            scope, target = f"guest:{guest[1]}", f"user:{u['id']}"
            c.execute("INSERT OR IGNORE INTO v6_guest_handoffs VALUES(?,?,?)", (scope, target, int(time.time())))
            if c.execute("SELECT owner FROM v6_guest_handoffs WHERE guest_scope=?", (scope,)).fetchone()[0] == target:
                c.execute("UPDATE v6_runs SET owner=? WHERE owner=?", (target, scope))
                handoff = scope
    resp = JSONResponse(content={"success": True, "role": u["role"], "custom_id": u["custom_id"],
                                 "must_change_password": bool(u.get("must_change_password")),
                                 "draft_scope": f"user:{u['id']}",
                                 "guest_draft_scope": handoff})
    resp.set_cookie("sid", tok, httponly=True, samesite="lax", secure=_secure_cookie(), max_age=60 * 60 * 24 * 7)
    req.state.guest_cookie_rotated = True
    resp.set_cookie(GUEST_COOKIE, secrets.token_hex(16), max_age=365 * 86400, httponly=True, samesite="lax", secure=_secure_cookie())
    return resp


@app.post("/api/logout")
def api_logout(req: Request):
    tok = get_token(req)
    if tok:
        db.delete_session(tok or "")
    response = JSONResponse({"success": True})
    response.delete_cookie("sid")
    return response


@app.get("/api/me")
def api_me(req: Request):
    u = current_user(req, allow_password_change=True)
    return {"user": db.user_public(u)}


class PasswordChangeIn(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(max_length=128)


@app.post("/api/password/change")
def api_change_password(r: PasswordChangeIn, req: Request):
    u = current_user(req, allow_password_change=True)
    if len(r.new_password) < 8 or len(r.new_password) > 128 or r.new_password == r.current_password:
        return _err(400, "新密码需为 8 至 128 位，且不能与原密码相同")
    if not db.change_password(u["id"], r.current_password, r.new_password):
        return _err(400, "当前密码不正确")
    response = JSONResponse({"success": True, "login_required": True})
    response.delete_cookie("sid")
    return response


# ---------------- Templates ----------------
class ItemIn(BaseModel):
    name: str
    img: Optional[str] = None
    weight: int = 1
    category: str = ""


class TemplateIn(BaseModel):
    title: str
    type: str = "dish"          # dish / prize / person
    mode: str = "normal"        # normal / no_repeat / weighted
    subtitle: str = ""
    rule: str = ""
    theme: str = ""
    positive_title: str = ""
    negative_title: str = ""
    draw_count: int = 1
    machine: str = ""
    items: list[ItemIn] = []


def _builtin_fallback(u: dict) -> list:
    """Superadmin / seed accounts without templates still get something to draw."""
    out = []
    for i, t in enumerate(db.DEFAULT_TEMPLATES):
        out.append({
            "id": -1 - i, "owner_id": u["id"], "title": t["title"], "type": t["type"],
            "mode": t.get("mode", "normal"), "subtitle": t.get("subtitle", ""),
            "rule": t.get("rule", ""), "theme": t.get("theme", ""),
            "positive_title": t.get("positive_title", ""), "negative_title": t.get("negative_title", ""),
            "draw_count": t.get("draw_count", 1), "items": t["items"],
            "premium": False, "locked": False,
        })
    return out


def _premium_templates_for(uid: Optional[int] = None) -> list:
    """付费模板实例。根据用户权益注入 locked 标记。
    uid 为 None(游客) 时全部 locked(引导注册/购买)。"""
    ent = {"packs": set(), "member": False}
    if uid is not None:
        ent = db.user_entitlements(uid)
    out = []
    for i, t in enumerate(db.PREMIUM_TEMPLATES):
        slug = t.get("product_slug", "")
        unlocked = ent["member"] or slug in ent["packs"]
        out.append({
            "id": -200 - i, "owner_id": uid or 0, "title": t["title"], "type": t["type"],
            "mode": t.get("mode", "normal"), "subtitle": t.get("subtitle", ""),
            "rule": t.get("rule", ""), "theme": t.get("theme", ""),
            "positive_title": t.get("positive_title", ""), "negative_title": t.get("negative_title", ""),
            "draw_count": t.get("draw_count", 1), "items": t["items"],
            "premium": True, "locked": not unlocked, "product_slug": slug,
        })
    return out


GUEST_TEMPLATES = [
    {"id": -101, "title": "今日吃什么", "type": "dish", "mode": "normal", "subtitle": "游客演示 · 注册可自建",
     "rule": "等权随机", "theme": "美食", "positive_title": "今天吃", "negative_title": "", "draw_count": 1,
     "items": [{"id": 1, "name": "火锅"}, {"id": 2, "name": "烧烤"}, {"id": 3, "name": "麻辣烫"},
               {"id": 4, "name": "螺蛳粉"}, {"id": 5, "name": "黄焖鸡"}, {"id": 6, "name": "沙拉"},
               {"id": 7, "name": "饺子"}, {"id": 8, "name": "日料"}, {"id": 9, "name": "汉堡"}, {"id": 10, "name": "粥"}]},
    {"id": -102, "title": "幸运抽奖(演示)", "type": "prize", "mode": "weighted", "subtitle": "游客演示 · 无保底图鉴",
     "rule": "按权重抽取", "theme": "抽奖", "positive_title": "恭喜抽中", "negative_title": "再接再厉", "draw_count": 1,
     "items": [{"id": 11, "name": "小奖·金币x10", "category": "common"}, {"id": 12, "name": "幸运·金币x50", "category": "rare"},
               {"id": 13, "name": "大奖·金币x200", "category": "epic"}, {"id": 14, "name": "传说·神秘礼盒", "category": "legend"},
               {"id": 15, "name": "谢谢参与", "category": "common"}]},
    {"id": -103, "title": "开会抽人(演示)", "type": "person", "mode": "normal", "subtitle": "游客演示",
     "rule": "等权抽1人", "theme": "点名", "positive_title": "抽到", "negative_title": "", "draw_count": 1, "machine": "slot",
     "items": [{"id": 16, "name": "张三"}, {"id": 17, "name": "李四"}, {"id": 18, "name": "王五"},
               {"id": 19, "name": "赵六"}, {"id": 20, "name": "钱七"}, {"id": 21, "name": "孙八"}]},
]


@app.get("/api/templates")
def api_list_templates(req: Request):
    subj = current_subject(req)
    if not subj or subj["kind"] == "guest":
        # 游客: 基础演示模板 + 付费模板(全部locked)
        return {"templates": GUEST_TEMPLATES + _premium_templates_for(None)}
    tpls = db.list_templates(subj["id"])
    if not tpls:
        tpls = _builtin_fallback(subj["user"])
    # 合并付费模板
    tpls = tpls + _premium_templates_for(subj["id"])
    return {"templates": tpls}


@app.get("/api/templates/{tid}")
def api_get_template(tid: int, req: Request):
    u = current_user(req)
    if tid < 0:  # builtin fallback
        for t in _builtin_fallback(u):
            if t["id"] == tid:
                return {"template": t}
        return _err(404, "模板不存在")
    t = db.get_template(u["id"], tid)
    if not t:
        return _err(404, "模板不存在")
    return {"template": t}


@app.post("/api/templates")
def api_create_template(r: TemplateIn, req: Request):
    u = current_user(req)
    tid = db.create_template(u["id"], r.model_dump())
    return {"success": True, "id": tid}


@app.put("/api/templates/{tid}")
def api_update_template(tid: int, r: TemplateIn, req: Request):
    u = current_user(req)
    if not db.update_template(u["id"], tid, r.model_dump()):
        return _err(404, "模板不存在")
    return {"success": True}


@app.delete("/api/templates/{tid}")
def api_delete_template(tid: int, req: Request):
    u = current_user(req)
    if not db.delete_template(u["id"], tid):
        return _err(404, "模板不存在")
    return {"success": True}


class ImportIn(BaseModel):
    names: list[str]


@app.post("/api/templates/{tid}/import")
def api_import_people(tid: int, r: ImportIn, req: Request):
    u = current_user(req)
    # 批量导入名单 = 自定义机台 Pro 权益(年卡会员)
    if not db.is_member("user", u["id"]) and u["role"] != "superadmin":
        return _err(403, "批量导入名单是内容年卡专属权益，开通年卡后解锁")
    t = db.get_template(u["id"], tid)
    if not t:
        return _err(404, "模板不存在")
    if t["type"] != "person":
        return _err(400, "仅人物类型可导入名单")
    # replace items with imported names
    db.update_template(u["id"], tid, {
        "title": t["title"], "type": t["type"], "mode": t["mode"], "subtitle": t.get("subtitle", ""),
        "rule": t.get("rule", ""), "theme": t.get("theme", ""), "positive_title": t.get("positive_title", ""),
        "negative_title": t.get("negative_title", ""), "draw_count": t.get("draw_count", 1),
        "items": [{"name": n} for n in r.names if (n or "").strip()],
    })
    return {"success": True, "count": len([n for n in r.names if n.strip()])}


# ---------------- Play (draw) ----------------
class PlayIn(BaseModel):
    template_id: int
    result: str
    tpl_title: str = ""


@app.post("/api/play")
def api_play(r: PlayIn, req: Request):
    subj = current_subject(req)
    if not subj:
        return _err(401, "请刷新页面后重试")
    allowed, msg, remaining = check_quota(subj)
    if not allowed:
        return _err(429, msg)
    if subj["kind"] == "user":
        db.log_play(subj["id"], r.template_id, r.result, r.tpl_title)
    else:
        db.log_guest_play(subj["id"], r.result)
    return {"success": True, "remaining": remaining}


class DrawIn(BaseModel):
    template_id: int | None = None
    count: int = 1


@app.post("/api/draw")
def api_draw(r: DrawIn, req: Request):
    """服务端游戏化抽取: 权重 + 稀有度 + 保底 + 图鉴/金币。仅 prize 类型走此通道。"""
    if r.template_id is None:
        return _err(400, "请先选择模板")
    subj = current_subject(req)
    if not subj:
        return _err(401, "请刷新页面后重试")
    u = subj.get("user")
    tpl = db.get_template(u["id"], r.template_id) if u else None
    if u and not tpl:
        return _err(404, "模板不存在")
    if tpl and tpl.get("type") != "prize":
        return _err(400, "该模板不支持概率池抽取")
    allowed, msg, remaining = check_quota(subj)
    if not allowed:
        return _err(429, msg)
    # 游客无模板体系 — 用内置演示奖池抽取
    if not u:
        results = db.draw_guest_demo(r.count)
    else:
        results = db.draw_game(u["id"], tpl, r.count)
        for x in results:
            db.log_play(u["id"], r.template_id, x["name"], (tpl or {}).get("title", ""))
    return {"success": True, "results": results,
            "meta": {i["name"]: {"rarity": i["category"] or "common"} for i in tpl["items"]} if tpl else {},
            "pity": db.get_pity(u["id"], r.template_id) if u else None,
            "remaining": remaining}


@app.get("/api/collection/{tid}")
def api_collection(tid: int, req: Request):
    u = current_user(req)
    return {"collection": db.get_collection(u["id"], tid),
            "pity": db.get_pity(u["id"], tid),
            "pity_epic": db.PITY_EPIC, "pity_legend": db.PITY_LEGEND,
            "rarity_meta": db.RARITY_META}


@app.get("/api/history")
def api_history(req: Request, limit: int = 50):
    """抽奖历史(z字记录)"""
    u = current_user(req)
    return {"history": db.list_play_history(u["id"], min(max(1, limit), 200))}


@app.get("/api/export")
def api_export(req: Request):
    """导出抽奖记录为 CSV — 内容年卡专属权益(自定义机台 Pro)"""
    u = current_user(req)
    if not db.is_member("user", u["id"]) and u["role"] != "superadmin":
        return _err(403, "结果导出是内容年卡专属权益，开通年卡后解锁")
    rows = db.list_play_history(u["id"], 5000)
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["时间", "模板", "结果"])
    def spreadsheet_text(value):
        value = str(value or '')
        return "'" + value if value.lstrip().startswith(('=', '+', '-', '@')) or value.startswith(('\t', '\r', '\n')) else value
    for r in reversed(rows):
        w.writerow([r.get("played_at", ""), spreadsheet_text(r.get("tpl_title", "")), spreadsheet_text(r.get("result", ""))])
    data = "\ufeff" + buf.getvalue()  # BOM 让 Excel 正确识别 UTF-8
    return Response(content=data, media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="lottery_history.csv"'})


class MachineIn(BaseModel):
    machine: str


@app.put("/api/templates/{tid}/machine")
def api_set_machine(tid: int, r: MachineIn, req: Request):
    u = current_user(req)
    if r.machine not in ("capsule", "slot", "egg", "card", "wheel", "table", "tubes"):
        return _err(400, "未知机台")
    c = db.conn()
    row = c.execute("SELECT id FROM templates WHERE id=? AND owner_id=?", (tid, u["id"])).fetchone()
    if not row:
        c.close(); return _err(404, "模板不存在")
    c.execute("UPDATE templates SET machine=? WHERE id=?", (r.machine, tid))
    c.commit(); c.close()
    return {"success": True}


@app.get("/api/qr")
def api_qr(data: str = ""):
    """二维码生成(支付码等)"""
    if not data:
        return _err(400, "missing data")
    if len(data.encode('utf-8')) > 1500:
        return _err(400, "二维码内容过长")
    import io
    import qrcode
    img = qrcode.make(data)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    from fastapi.responses import Response
    return Response(content=buf.getvalue(), media_type="image/png")


# ---------------- Historical content membership (read-only payment state) ----------------
@app.get("/api/saas/status")
def api_saas_status(req: Request):
    """前端进入时调用: 游客/会员状态 + 剩余次数 + 支付渠道是否开放"""
    subj = current_subject(req)
    if not subj:
        return {"kind": "guest", "member": False, "remaining": _guest_daily_limit(),
                "pay_enabled": False,
                "price_cents": _member_price_cents()}
    if subj["kind"] == "user":
        u = subj["user"]
        remaining = -1 if subj["member"] or u["role"] == "superadmin" else max(0, db.DAILY_LIMIT - u["daily_count"])
    else:
        g = db.get_or_create_guest(subj["gk"])
        today = time.strftime("%Y-%m-%d")
        used = g["daily_count"] if g["last_play_date"] == today else 0
        remaining = -1 if subj["member"] else max(0, _guest_daily_limit() - used)
    return {"kind": subj["kind"], "member": bool(subj["member"]),
            "member_expiry": db.member_expiry(subj["kind"], subj["id"]) if subj["member"] else "",
            "remaining": remaining,
            "pay_enabled": False,
            "price_cents": _member_price_cents()}


@app.get("/api/shop/products")
def api_shop_products(req: Request):
    """内容商城商品列表(含已购状态)"""
    prods = db.list_products()
    subj = current_subject(req)
    owned = set()
    member = False
    if subj:
        owned = set(db.list_purchases(subj["kind"], subj["id"]))
        member = bool(subj["member"])
    out = []
    for p in prods:
        is_owned = (p["kind"] == "membership" and member) or (p["id"] in owned)
        out.append({**p, "owned": is_owned})
    return {"products": out, "member": member}


@app.get("/api/shop/my")
def api_shop_my(req: Request):
    """我的已购内容"""
    subj = current_subject(req)
    if not subj:
        return {"products": [], "member": False}
    owned = set(db.list_purchases(subj["kind"], subj["id"]))
    prods = db.list_products()
    names = [p["name"] for p in prods if p["id"] in owned or (p["kind"] == "membership" and subj["member"])]
    return {"products": names, "member": bool(subj["member"])}


@app.get("/api/shop/entitlements")
def api_shop_entitlements(req: Request):
    """当前用户的权益快照: 已购模板包 + 年卡状态 + 是否可自定义机台Pro"""
    subj = current_subject(req)
    if not subj:
        return {"member": False, "packs": [], "can_custom_pro": False}
    owned = set(db.list_purchases(subj["kind"], subj["id"]))
    member = bool(subj["member"])
    packs = [p["slug"] for p in db.list_products() if p["kind"] == "pack" and p["id"] in owned]
    return {"member": member, "packs": packs, "can_custom_pro": member}


@app.post("/api/saas/buy")
def api_saas_buy():
    return _err(410, "旧版商品支付已停用。新版会员和皮肤请到 3D 抽奖台的机台与主题入口查看")


@app.post("/api/saas/notify")
def api_saas_notify():
    return _err(410, "旧版支付回调已停用")


@app.get("/api/saas/order/{order_no}")
def api_saas_order(order_no: str, req: Request):
    """前端轮询订单状态"""
    subj = current_subject(req)
    o = db.get_order(order_no)
    if not subj or not o or o["subject_type"] != subj["kind"] or o["subject_id"] != subj["id"]:
        return _err(404, "订单不存在")
    return {"order_no": o["order_no"], "status": o["status"], "amount": o["amount"]}


# ---------------- Superadmin (only used internally if needed) ----------------
@app.get("/api/admin/settings")
def api_admin_settings_get(req: Request):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    return {"settings": {
        "guest_daily_limit": _guest_daily_limit(),
        "ip_daily_limit": _ip_daily_limit(),
        "member_price_cents": _member_price_cents(),
        "member_days": _cfg_int("member_days", db.MEMBER_DAYS),
        "registration_open": _reg_open(),
            "register_per_ip_daily": _cfg_int("register_per_ip_daily", 3),
    }}


@app.post("/api/admin/settings")
async def api_admin_settings_set(req: Request):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    try:
        body = await req.json()
    except Exception:
        return _err(400, "参数错误")
    allowed = {"guest_daily_limit", "ip_daily_limit", "member_price_cents", "member_days", "registration_open"}
    changed = {}
    for k, v in (body or {}).items():
        if k not in allowed:
            continue
        if k == "registration_open":
            db.set_setting(k, "1" if v else "0")
        else:
            n = int(v)
            if n < 0:
                return _err(400, f"{k} 不能为负数")
            db.set_setting(k, str(n))
        changed[k] = v
    return {"success": True, "changed": changed}


class FeedbackIn(BaseModel):
    content: str = Field(min_length=5, max_length=30)


@app.post("/api/feedback")
def api_feedback(r: FeedbackIn, req: Request):
    """Compatibility endpoint shares the V8 inbox and durable abuse limits."""
    import v8_feedback as feedback
    owner = feedback.identity(req, current_user, current_subject)
    if len(r.content.strip()) < 5:
        return _err(400, '请填写至少 5 个字的反馈')
    body = feedback.FeedbackIn(request_id=secrets.token_hex(16), category='other', content=r.content)
    return {"success": True, **feedback.submit(owner, body, req.client.host if req.client else '')}


@app.get("/api/admin/feedback")
def api_admin_feedback(req: Request):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    import v8_feedback as feedback
    rows = feedback.admin_list()["items"]
    return {"feedback": [{**row, "subject_type": row['owner'].split(':', 1)[0],
                          "subject_id": int(row['owner'].split(':', 1)[1]), "priority": 0} for row in rows]}


@app.get("/api/admin/users")
def api_admin_users(req: Request, q: str = "", status: str = "", page: int = 1, page_size: int = 25):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    if len(q.strip()) > 80 or status not in ("", "active", "disabled", "banned") or page < 1 or not 1 <= page_size <= 100:
        return _err(400, "查询条件无效")
    return db.search_users(q.strip(), status, page, page_size)


@app.get("/api/admin/stats")
def api_admin_stats(req: Request):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    c = db.conn()
    total_plays = c.execute("SELECT COUNT(*) n FROM play_log").fetchone()["n"]
    today = time.strftime("%Y-%m-%d")
    today_plays = c.execute("SELECT COUNT(*) n FROM play_log WHERE played_at LIKE ?", (today + "%",)).fetchone()["n"]
    user_count = c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"]
    tpl_count = c.execute("SELECT COUNT(*) n FROM templates").fetchone()["n"]
    top = [{"result": r["result"], "n": r["n"]} for r in c.execute(
        "SELECT result, COUNT(*) n FROM play_log GROUP BY result ORDER BY n DESC LIMIT 8")]
    recent = [dict(r) for r in c.execute(
        "SELECT p.result, p.played_at, u.custom_id FROM play_log p LEFT JOIN users u ON u.id=p.user_id "
        "ORDER BY p.id DESC LIMIT 10")]
    c.close()
    return {"total_plays": total_plays, "today_plays": today_plays,
            "user_count": user_count, "template_count": tpl_count, "top_results": top, "recent": recent}


class StatusIn(BaseModel):
    status: str
    reason: str = "管理员操作"


@app.post("/api/admin/users/{uid}/status")
def api_admin_status(uid: int, r: StatusIn, req: Request):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    if not 2 <= len(r.reason.strip()) <= 200:
        return _err(400, "请填写 2 至 200 字的操作原因")
    if not db.set_user_status(uid, r.status, actor_id=u["id"], reason=r.reason):
        return _err(400, "状态无效、账号不存在，或不能停用自己／最后一名有效超管")
    return {"success": True}


class AdminResetIn(BaseModel):
    reason: str = "管理员重置密码"


@app.post("/api/admin/users/{uid}/reset-password")
def api_admin_reset_password(uid: int, req: Request, body: AdminResetIn = AdminResetIn()):
    u = current_user(req)
    if u["role"] != "superadmin":
        return _err(403, "无权限")
    if not 2 <= len(body.reason.strip()) <= 200:
        return _err(400, "请填写 2 至 200 字的重置原因")
    temporary = db.reset_user_password(uid, u["id"], body.reason)
    if not temporary:
        return _err(400, "账号不存在；超管请使用自助改密")
    return {"success": True, "temporary_password": temporary,
            "message": "临时密码只显示本次；请安全交给账号本人，首次登录必须修改"}


# ================= 名单库 + 分组 (v4.2) =================
class ListIn(BaseModel):
    title: str
    items: list


@app.get("/api/lists")
def api_lists(req: Request):
    u = current_user(req)
    return {"lists": db.list_name_lists(u["id"])}


@app.post("/api/lists")
def api_lists_create(r: ListIn, req: Request):
    u = current_user(req)
    if not (r.title or "").strip():
        return _err(400, "请填写名单名称")
    names = [i if isinstance(i, str) else (i.get("name") or "") for i in (r.items or [])]
    names = [x.strip() for x in names if (x or "").strip()]
    if not names:
        return _err(400, "名单不能为空")
    lid = db.create_name_list(u["id"], r.title.strip(), names)
    return {"success": True, "id": lid}


@app.delete("/api/lists/{lid}")
def api_lists_delete(lid: int, req: Request):
    u = current_user(req)
    if not db.delete_name_list(u["id"], lid):
        return _err(404, "名单不存在")
    return {"success": True}


class GroupDrawIn(BaseModel):
    names: list[str] = []
    groups: int = 2


@app.post("/api/draw/group")
def api_draw_group(r: GroupDrawIn, req: Request):
    """分组玩法: 前端传名单+组数, 一次随机均分到 groups 组。"""
    subj = current_subject(req)
    if not subj:
        return _err(401, "请刷新页面后重试")
    names = [x.strip() for x in (r.names or []) if (x or "").strip()]
    groups = r.groups
    if len(names) < 2:
        return _err(400, "名单至少需要 2 人")
    if groups < 2 or groups > len(names):
        return _err(400, "组数必须在 2 和人数之间")
    result = db.draw_groups(names, groups)
    return {"success": True, "groups": result}


import v6_api
import v6_engine
import v6_payments
import v7_referrals
import v7_api
import v7_entitlements
import v7_operations
v6_api.install(app, current_subject)
v7_api.install(app, current_user, current_subject)

# ---------------- Static ----------------
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(STATIC_DIR, exist_ok=True)


@app.get("/")
def root_page(req: Request):
    target = "/play.html" if any(key in req.query_params for key in ("app", "display", "order", "scene", "skin")) else "/login.html"
    return RedirectResponse(target + ("?" + req.url.query if req.url.query else ""), status_code=302)


@app.get("/index.html")
@app.get("/home.html")
def old_play_entry(req: Request):
    return RedirectResponse("/play.html" + ("?" + req.url.query if req.url.query else ""), status_code=302)


@app.get("/password.html")
def old_password_entry(req: Request):
    params = [(key,value) for key,value in parse_qsl(req.url.query) if key != "mode"] + [("mode","password")]
    return RedirectResponse("/login.html?" + urlencode(params), status_code=302)


@app.get("/payment-return.html")
def old_payment_return(req: Request):
    return RedirectResponse("/play.html" + ("?" + req.url.query if req.url.query else ""), status_code=302)


@app.get("/admin.html")
def admin_page(req: Request):
    try:
        user = current_user(req)
    except HTTPException as exc:
        if exc.status_code == 401:
            return RedirectResponse("/login.html?next=%2Fadmin.html", status_code=302)
        if "临时密码" in str(exc.detail):
            return RedirectResponse("/login.html?mode=password&next=%2Fadmin.html", status_code=302)
        raise
    if user["role"] != "superadmin":
        raise HTTPException(403,"无管理权限")
    return FileResponse(os.path.join(STATIC_DIR,"admin.html"))


class ApplicationStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        # StaticFiles normalizes trailing slashes and filesystem path spelling.
        # Send equivalent private/legacy documents through their guarded route,
        # including case variants on Windows, rather than serving the raw HTML.
        normalized = path.replace("\\", "/").strip("/").lower()
        routed = {"admin.html", "index.html", "home.html", "password.html", "payment-return.html"}
        if normalized in routed:
            query = scope.get("query_string", b"").decode("latin-1")
            return RedirectResponse("/" + normalized + ("?" + query if query else ""), status_code=302)
        return await super().get_response(path, scope)


app.mount("/", ApplicationStaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    db.init_db()
    v6_engine.init_schema()
    v6_payments.init_schema()
    v7_referrals.init_schema()
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8899)
