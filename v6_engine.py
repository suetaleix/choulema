"""V6 authoritative, transactional draw state. Rendering never chooses winners."""
from __future__ import annotations

import hashlib
import json
import secrets
import time
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

import db
import v7_catalog as content_catalog


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    weight: int = Field(default=1, ge=1, le=10000)
    stock: int = Field(default=1, ge=0, le=10000)
    excluded: bool = False
    tags: list[str] = Field(default_factory=list, max_length=10)


class Award(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    count: int = Field(ge=1, le=500)


class DrawConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="我的抽取", min_length=1, max_length=80)
    app: Literal["food", "play", "prize", "person"] = "food"
    mode: Literal["normal", "weighted", "no_repeat", "inventory", "winners", "groups"] = "normal"
    machine: str = Field(default="capsule", max_length=50)
    theme: str = Field(default="classic", max_length=50)
    sound: str = Field(default="", max_length=50)
    tag_filter: str = Field(default="", max_length=30)
    count: int = Field(default=1, ge=1, le=50)
    group_count: int = Field(default=2, ge=2, le=50)
    items: list[Candidate] = Field(min_length=1, max_length=1000)
    awards: list[Award] = Field(default_factory=list, max_length=30)
    cross_award_unique: bool = True
    brand: str = Field(default="", max_length=80)
    accent: str = Field(default="#a3ff70", pattern=r"^#[0-9a-fA-F]{6}$")
    source_config_id: str = Field(default="", max_length=80)
    source_config_revision: int = Field(default=0, ge=0)
    logo: str = Field(default="", max_length=700000)
    backdrop: str = Field(default="", max_length=1500000)

    @model_validator(mode="after")
    def validate_rules(self):
        machine, _ = content_catalog.appearance(self.machine, self.theme, self.sound)
        import re
        import base64
        import io
        from PIL import Image, UnidentifiedImageError
        for media in (self.logo, self.backdrop):
            if media and not re.fullmatch(r"data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+", media):
                raise ValueError("品牌图片仅支持本地 PNG、JPEG 或 WebP 图片")
            if media:
                try:
                    raw = base64.b64decode(media.split(",", 1)[1], validate=True)
                    # Select allowed decoders before opening attacker-controlled bytes.
                    with Image.open(io.BytesIO(raw), formats=['PNG', 'JPEG', 'WEBP']) as image:
                        if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > 16000000:
                            raise ValueError("image too large")
                        image.verify()
                except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
                    raise ValueError("品牌图片损坏或尺寸过大，请使用 1600 万像素以内的图片")
        if len({i.id for i in self.items}) != len(self.items):
            raise ValueError("候选编号不能重复；同名人员请使用不同编号")
        if any(not i.name.strip() for i in self.items):
            raise ValueError("候选名称不能为空白")
        if len({a.id for a in self.awards}) != len(self.awards):
            raise ValueError("奖项编号不能重复")
        if self.mode in {"inventory", "winners"} and self.app != "prize":
            raise ValueError("库存与获奖人模式仅用于抽奖品")
        if self.mode == "groups" and self.app != "person":
            raise ValueError("分组仅用于点个名")
        if self.app in {"food", "play"} and self.count != 1:
            raise ValueError("日常选择每次给出一个答案")
        if self.count > machine['max_count'] or self.mode not in machine['modes']:
            raise ValueError('该机台不支持当前人数或规则，多人/分组请使用姓名星球')
        if sum(not i.excluded for i in self.items) > machine['max_items']:
            raise ValueError(f"{machine['name']}最多展示 {machine['max_items']} 项，请切换其他机台")
        return self


class DomainError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message, self.status = message, status


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def init_schema():
    with db.conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS v6_schema(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS v6_configs(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_v6_configs_owner ON v6_configs(owner);
        CREATE TABLE IF NOT EXISTS v6_runs(
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL,
          rehearsal INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, control_hash TEXT NOT NULL, view_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS v6_draws(
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES v6_runs(id),
          request_id TEXT NOT NULL, award_id TEXT NOT NULL DEFAULT '', result TEXT NOT NULL,
          created_at INTEGER NOT NULL, UNIQUE(run_id,request_id));
        CREATE TABLE IF NOT EXISTS v6_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES v6_runs(id),
          kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS v6_entitlements(
          owner TEXT NOT NULL, feature TEXT NOT NULL, expires_at INTEGER,
          source TEXT NOT NULL, PRIMARY KEY(owner,feature,source));
        CREATE TABLE IF NOT EXISTS v6_presentations(
          run_id TEXT PRIMARY KEY REFERENCES v6_runs(id), request_id TEXT NOT NULL,
          award_id TEXT NOT NULL, controller_id TEXT NOT NULL, phase TEXT NOT NULL,
          updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS v6_view_tokens(run_id TEXT NOT NULL, token_hash TEXT NOT NULL, PRIMARY KEY(run_id,token_hash));
        CREATE TABLE IF NOT EXISTS v6_guest_handoffs(
          guest_scope TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO v6_schema VALUES(1,strftime('%s','now'));
        """)


def features(owner):
    with db.conn() as c:
        rows = c.execute("""SELECT e.feature FROM v6_entitlements e
            LEFT JOIN v6_entitlement_revocations r
            ON r.owner=e.owner AND r.feature=e.feature AND r.source=e.source
            WHERE e.owner=? AND r.source IS NULL AND (e.expires_at IS NULL OR e.expires_at>?)""",
            (owner, int(time.time()))).fetchall()
    result = {r["feature"] for r in rows}
    if owner.startswith("user:"):
        uid = int(owner.split(":")[1])
        u = db.get_user(uid)
        if u and (u["role"] == "superadmin" or db.is_member("user", uid)):
            result.update({"pro", "cosmic"})
        if u and u["role"] == "superadmin":
            result.update(p["feature"] for p in content_catalog.PRODUCTS.values())
    return result


def has_capability(owner, key):
    return content_catalog.has_capability(features(owner), key)


def require_features(owner, config, rehearsal=False):
    owned = features(owner)
    machine, theme = content_catalog.appearance(config.machine, config.theme, config.sound)
    content_catalog.require_available(config.machine, config.theme)
    for key, needed in [('multi_award', len(config.awards) > 1), ('branding', bool(config.brand or config.logo or config.backdrop))]:
        if needed and not content_catalog.state('capabilities', key)['enabled']:
            raise DomainError(content_catalog.CONTENT['capabilities'][key]['name'] + '暂时维护中', 403)
    if rehearsal:
        return
    for item in (machine, theme):
        if item.get('feature') and item['feature'] not in owned:
            raise DomainError(item['name'] + '可免费预览，正式使用需要对应权益', 403)
    if len(config.awards) > 1 and not content_catalog.has_capability(owned, 'multi_award'):
        raise DomainError('多奖项需要专业权益，或该功能正在维护', 403)
    if (config.brand or config.logo or config.backdrop) and not content_catalog.has_capability(owned, 'branding'):
        raise DomainError('品牌设置需要专业权益，或该功能正在维护', 403)


def list_configs(owner):
    with db.conn() as c:
        rows = c.execute("SELECT * FROM v6_configs WHERE owner=? ORDER BY updated_at DESC", (owner,)).fetchall()
    return [dict(id=r["id"], revision=r["revision"], config=json.loads(r["payload"])) for r in rows]


def save_config(owner, config, config_id=None, revision=None):
    if not owner.startswith("user:"):
        raise DomainError("登录后可保存到账号，当前草稿已保留在设备", 401)
    cid = config_id or uuid.uuid4().hex
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM v6_configs WHERE id=? AND owner=?", (cid, owner)).fetchone()
        if config_id and not row:
            raise DomainError("配置不存在", 404)
        if row and revision != row["revision"]:
            raise DomainError("配置已更新，请重新载入后再保存", 409)
        rev = row["revision"] + 1 if row else 1
        c.execute("INSERT INTO v6_configs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at", (cid, owner, encoded(config.model_dump()), rev, int(time.time())))
    return {"id": cid, "revision": rev}


def new_run(owner, config, rehearsal=False):
    require_features(owner, config, rehearsal)
    rid, control, view = uuid.uuid4().hex, secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        from v7_operations import ensure_new_work
        ensure_new_work(c)
        if config.source_config_id:
            source = c.execute("SELECT revision FROM v6_configs WHERE id=? AND owner=?", (config.source_config_id, owner)).fetchone()
            if not source:
                raise DomainError("来源配置不存在，请另存到当前账号", 404)
            if config.source_config_revision and config.source_config_revision != source["revision"]:
                raise DomainError("保存的配置已更新，请重新载入后开始新课次", 409)
        c.execute("INSERT INTO v6_runs VALUES(?,?,?,?,?,?,?,?)", (rid, owner, encoded(config.model_dump()), int(rehearsal), 0, int(time.time()), digest(control), digest(view)))
    return {"id": rid, "control_token": control, "view_token": view, "rehearsal": rehearsal}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _run(c, owner, rid):
    row = c.execute("SELECT * FROM v6_runs WHERE id=? AND owner=?", (rid, owner)).fetchone()
    if not row:
        raise DomainError("场次不存在", 404)
    return row


def get_run(owner, rid):
    with db.conn() as c:
        row = _run(c, owner, rid)
        draws = c.execute("SELECT * FROM v6_draws WHERE run_id=? ORDER BY id", (rid,)).fetchall()
        events = c.execute("SELECT kind,payload,created_at FROM v6_events WHERE run_id=? ORDER BY id", (rid,)).fetchall()
        presentation = c.execute("SELECT * FROM v6_presentations WHERE run_id=?", (rid,)).fetchone()
    return {"id": rid, "config": json.loads(row["payload"]), "rehearsal": bool(row["rehearsal"]), "archived": bool(row["archived"]),
            "draws": [{"id": d["id"], "award_id": d["award_id"], "created_at": d["created_at"], **json.loads(d["result"])} for d in draws],
            "events": [{**dict(e), "payload": json.loads(e["payload"])} for e in events],
            "presentation": dict(presentation) if presentation else None}


def list_runs(owner):
    with db.conn() as c:
        rows = c.execute("SELECT id,payload,rehearsal,archived,created_at FROM v6_runs WHERE owner=? ORDER BY created_at DESC,rowid DESC LIMIT 100", (owner,)).fetchall()
    return [{"id": r["id"], "title": json.loads(r["payload"])["title"], "rehearsal": bool(r["rehearsal"]), "archived": bool(r["archived"]), "created_at": r["created_at"]} for r in rows]


def start(owner, rid, request_id, control, award_id="", controller_id=""):
    """Start the shared presentation; no winner or quota is consumed yet."""
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        run = _run(c, owner, rid)
        if not secrets.compare_digest(run["control_hash"], digest(control)):
            raise DomainError("此页面没有主持控制权", 403)
        if run["archived"]:
            raise DomainError("此轮已结束", 409)
        cfg = DrawConfig.model_validate_json(run["payload"])
        require_features(owner, cfg, bool(run["rehearsal"]))
        if cfg.awards and award_id not in {a.id for a in cfg.awards}:
            raise DomainError("请选择有效奖项")
        old = c.execute("SELECT * FROM v6_presentations WHERE run_id=?", (rid,)).fetchone()
        if old and old["phase"] == "spinning":
            if (old["request_id"], old["award_id"], old["controller_id"]) != (request_id, award_id, controller_id):
                raise DomainError("已有主持页面正在抽取，请先完成或接管该次抽取", 409)
            return dict(old)
        if c.execute("SELECT 1 FROM v6_draws WHERE run_id=? AND request_id=?", (rid, request_id)).fetchone():
            return {"phase": "revealed", "request_id": request_id}
        _available_pool(c, rid, cfg, award_id)
        c.execute("INSERT INTO v6_presentations VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET request_id=excluded.request_id,award_id=excluded.award_id,controller_id=excluded.controller_id,phase=excluded.phase,updated_at=excluded.updated_at", (rid, request_id, award_id, controller_id, "spinning", int(time.time())))
    return {"phase": "spinning", "request_id": request_id}


def take_control(owner, rid, controller_id):
    """Explicit recovery rotates the sole controller token, revoking old pages."""
    token, view = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        run = _run(c, owner, rid)
        if run["archived"]:
            raise DomainError("此轮已结束，只能查看记录", 409)
        c.execute("UPDATE v6_runs SET control_hash=? WHERE id=?", (digest(token), rid))
        c.execute("INSERT INTO v6_view_tokens VALUES(?,?)", (rid, digest(view)))
        c.execute("UPDATE v6_presentations SET controller_id=? WHERE run_id=?", (controller_id, rid))
        c.execute("INSERT INTO v6_events(run_id,kind,payload,created_at) VALUES(?,?,?,?)", (rid, "control", encoded({"reason": "主持人接管控制"}), int(time.time())))
    return {"id": rid, "control_token": token, "view_token": view, "rehearsal": bool(run["rehearsal"])}


def cancel_presentation(owner, rid, request_id, control, controller_id):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        run = _run(c, owner, rid)
        if not secrets.compare_digest(run["control_hash"], digest(control)):
            raise DomainError("缺少主持控制权", 403)
        c.execute("UPDATE v6_presentations SET phase='idle',updated_at=? WHERE run_id=? AND request_id=? AND controller_id=? AND phase='spinning'", (int(time.time()), rid, request_id, controller_id))


def _available_pool(c, rid, cfg, award_id):
    """Read-only eligibility checks shared by start and transactional reveal."""
    previous = c.execute("SELECT * FROM v6_draws WHERE run_id=?", (rid,)).fetchall()
    records = [(r["award_id"], json.loads(r["result"])["results"]) for r in previous]
    events = c.execute("SELECT payload FROM v6_events WHERE run_id=? AND kind='forfeit'", (rid,)).fetchall()
    forfeits = {(e["draw_id"], e["candidate_id"]) for row in events for e in [json.loads(row["payload"])]}
    pool = [i.model_dump() for i in cfg.items if not i.excluded and (not cfg.tag_filter or cfg.tag_filter in i.tags)]
    used = [i["id"] for _, items in records for i in items]
    n = cfg.count
    awards = {a.id: a for a in cfg.awards}
    if cfg.mode == "winners" and awards:
        if award_id not in awards:
            raise DomainError("请选择有效奖项")
        total = sum(1 for r in previous if r["award_id"] == award_id for i in json.loads(r["result"])["results"] if (r["id"], i["id"]) not in forfeits)
        left = awards[award_id].count - total
        if left <= 0:
            raise DomainError("当前奖项已抽满")
        n = min(n, left)
    elif award_id:
        raise DomainError("当前场次没有此奖项")
    if cfg.mode == "no_repeat" or cfg.app == "person" or cfg.mode == "winners":
        excluded = set(used)
        if cfg.mode == "winners" and not cfg.cross_award_unique:
            excluded = {i["id"] for a, items in records if a == award_id for i in items}
        pool = [i for i in pool if i["id"] not in excluded]
    if cfg.mode == "inventory":
        pool = [dict(i, remaining=i["stock"] - used.count(i["id"])) for i in pool]
        pool = [i for i in pool if i["remaining"] > 0]
    if cfg.mode == "groups":
        if previous:
            raise DomainError("本轮已分组，请明确新建一轮")
        if cfg.group_count > len(pool):
            raise DomainError("组数不能超过参与人数")
    else:
        capacity = sum(i["remaining"] for i in pool) if cfg.mode == "inventory" else len(pool)
        if capacity < n:
            raise DomainError(f"候选不足：剩余 {capacity}，本次需 {n}。请调整或明确新建一轮")
    return pool, n, awards


def draw(owner, rid, request_id, control, award_id="", controller_id=""):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        run = _run(c, owner, rid)
        if not secrets.compare_digest(run["control_hash"], digest(control)):
            raise DomainError("此页面没有主持控制权，请回到原控制页面", 403)
        existing = c.execute("SELECT * FROM v6_draws WHERE run_id=? AND request_id=?", (rid, request_id)).fetchone()
        if existing:
            if existing["award_id"] != award_id:
                raise DomainError("同一请求不能更换奖项", 409)
            return {"id": existing["id"], **json.loads(existing["result"])}
        if run["archived"]:
            raise DomainError("此轮已结束，请新建一轮", 409)
        presentation = c.execute("SELECT * FROM v6_presentations WHERE run_id=?", (rid,)).fetchone()
        if presentation and presentation["phase"] == "spinning" and (presentation["request_id"], presentation["award_id"], presentation["controller_id"]) != (request_id, award_id, controller_id):
            raise DomainError("另一主持页面正在抽取，请回到原页面或明确接管", 409)
        cfg = DrawConfig.model_validate_json(run["payload"])
        require_features(owner, cfg, bool(run["rehearsal"]))
        pool, n, awards = _available_pool(c, rid, cfg, award_id)
        if cfg.mode == "groups":
            secrets.SystemRandom().shuffle(pool)
            groups = [pool[i::cfg.group_count] for i in range(cfg.group_count)]
            results = pool
        else:
            groups = []
            results = []
            for _ in range(n):
                weights = [i["weight"] if cfg.mode == "weighted" else 1 for i in pool]
                r = secrets.randbelow(sum(weights))
                index = 0
                for index, weight in enumerate(weights):
                    if r < weight:
                        break
                    r -= weight
                selected = dict(pool[index])
                selected.pop("remaining", None)
                results.append(selected)
                if cfg.mode == "inventory":
                    pool[index]["remaining"] -= 1
                    if pool[index]["remaining"] == 0:
                        pool.pop(index)
                else:
                    pool.pop(index)
        result = {"results": results, "groups": groups, "award": awards[award_id].name if award_id in awards else "", "rehearsal": bool(run["rehearsal"])}
        cur = c.execute("INSERT INTO v6_draws(run_id,request_id,award_id,result,created_at) VALUES(?,?,?,?,?)", (rid, request_id, award_id, encoded(result), int(time.time())))
        c.execute("UPDATE v6_presentations SET phase='revealed',updated_at=? WHERE run_id=? AND request_id=?", (int(time.time()), rid, request_id))
        return {"id": cur.lastrowid, **result}


def archive(owner, rid, control):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = _run(c, owner, rid)
        if not secrets.compare_digest(row["control_hash"], digest(control)):
            raise DomainError("缺少主持控制权", 403)
        c.execute("UPDATE v6_runs SET archived=1 WHERE id=?", (rid,))
        c.execute("UPDATE v6_presentations SET phase='ended',updated_at=? WHERE run_id=?", (int(time.time()), rid))


def change_appearance(owner, rid, control, machine, theme, sound):
    """Change presentation only, preserving draws, stock and no-repeat history."""
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        run = _run(c, owner, rid)
        if not secrets.compare_digest(run["control_hash"], digest(control)):
            raise DomainError("缺少主持控制权", 403)
        if run["archived"]:
            raise DomainError("此轮已结束，请新建一轮", 409)
        presentation = c.execute("SELECT phase FROM v6_presentations WHERE run_id=?", (rid,)).fetchone()
        if presentation and presentation["phase"] == "spinning":
            raise DomainError("演出进行中，请揭晓后再调整外观", 409)
        from pydantic import ValidationError
        try:
            config = DrawConfig.model_validate({**json.loads(run["payload"]), "machine": machine, "theme": theme, "sound": sound})
        except ValidationError as error:
            raise DomainError(str(error.errors()[0]["msg"]), 422)
        require_features(owner, config, bool(run["rehearsal"]))
        c.execute("UPDATE v6_runs SET payload=? WHERE id=?", (encoded(config.model_dump()), rid))
    return {"machine": config.machine, "theme": config.theme, "sound": config.sound}


def forfeit(owner, rid, control, draw_id, candidate_id, reason):
    if not reason.strip():
        raise DomainError("请记录弃奖原因")
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        run = _run(c, owner, rid)
        if not secrets.compare_digest(run["control_hash"], digest(control)):
            raise DomainError("缺少主持控制权", 403)
        if run["archived"] or json.loads(run["payload"])["mode"] != "winners":
            raise DomainError("此场次不能补抽")
        row = c.execute("SELECT * FROM v6_draws WHERE id=? AND run_id=?", (draw_id, rid)).fetchone()
        if not row or candidate_id not in {i["id"] for i in json.loads(row["result"])["results"]}:
            raise DomainError("获奖记录不存在", 404)
        for event in c.execute("SELECT payload FROM v6_events WHERE run_id=? AND kind='forfeit'", (rid,)):
            event = json.loads(event["payload"])
            if event["draw_id"] == draw_id and event["candidate_id"] == candidate_id:
                return
        c.execute("INSERT INTO v6_events(run_id,kind,payload,created_at) VALUES(?,?,?,?)", (rid, "forfeit", encoded({"draw_id": draw_id, "candidate_id": candidate_id, "reason": reason.strip()}), int(time.time())))


def view_run(rid, token):
    with db.conn() as c:
        row = c.execute("SELECT * FROM v6_runs WHERE id=?", (rid,)).fetchone()
        extra = c.execute("SELECT 1 FROM v6_view_tokens WHERE run_id=? AND token_hash=?", (rid, digest(token))).fetchone()
        if not row or not (secrets.compare_digest(row["view_hash"], digest(token)) or extra):
            raise DomainError("展示链接无效", 404)
        latest = c.execute("SELECT * FROM v6_draws WHERE run_id=? ORDER BY id DESC LIMIT 1", (rid,)).fetchone()
        count = c.execute("SELECT count(*) FROM v6_draws WHERE run_id=?", (rid,)).fetchone()[0]
        forfeits = [json.loads(e["payload"]) for e in c.execute("SELECT payload FROM v6_events WHERE run_id=? AND kind='forfeit'", (rid,))]
        presentation = c.execute("SELECT phase,request_id,award_id,updated_at FROM v6_presentations WHERE run_id=?", (rid,)).fetchone()
    cfg = json.loads(row["payload"])
    # The audience restores only the latest reveal; full history remains owner-only.
    state = {"id": rid, "rehearsal": bool(row["rehearsal"]), "archived": bool(row["archived"]),
             "draw_count": count, "presentation": dict(presentation) if presentation else None,
             "draws": [{"id": latest["id"], "award_id": latest["award_id"], "created_at": latest["created_at"], **json.loads(latest["result"])}] if latest else []}
    state["title"], state["brand"], state["accent"] = cfg["title"], cfg["brand"], cfg["accent"]
    state["logo"], state["backdrop"] = cfg.get("logo", ""), cfg.get("backdrop", "")
    state["machine"], state["theme"] = cfg["machine"], cfg["theme"]
    state["sound"] = cfg.get("sound", "")
    if state["presentation"]:
        state["presentation"].pop("controller_id", None)
    # Read-only projection never exposes the entire roster or owner/control tokens.
    for draw_result in state["draws"]:
        draw_result["forfeited"] = sorted(e["candidate_id"] for e in forfeits if e["draw_id"] == draw_result["id"])
        draw_result["results"] = [{"id": i["id"], "name": i["name"]} for i in draw_result["results"]]
        draw_result["groups"] = [[{"id": i["id"], "name": i["name"]} for i in group] for group in draw_result["groups"]]
    return state
