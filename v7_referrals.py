"""Versioned referral campaigns and transactional, source-scoped rewards.

Only a successful new-user insert can consume a guest attribution. Rendering,
client claims, old accounts and repeated callbacks cannot create qualifications.
"""
from __future__ import annotations

import json
import secrets
import time
from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, ConfigDict, Field, model_validator

import db
import v6_commerce as commerce
import v6_payments as payments
from v6_engine import DomainError

CHINA = timezone(timedelta(hours=8))


class CampaignInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="好友同行，好运加时", min_length=1, max_length=80)
    enabled: bool = True
    pro_days: int = Field(default=30, ge=1, le=3650, strict=True)
    skin_feature: str = Field(default="cosmic", max_length=50)
    skin_days: int = Field(default=30, ge=1, le=3650, strict=True)
    monthly_cap: int = Field(default=3, ge=1, le=100, strict=True)
    reward_newcomer: bool = False
    require_experience: bool = False
    attribution_days: int = Field(default=30, ge=1, le=90, strict=True)
    starts_at: int | None = Field(default=None, ge=0)
    ends_at: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_dates(self):
        if not self.name.strip():
            raise ValueError("活动名称不能为空")
        if self.starts_at is not None and self.ends_at is not None and self.ends_at <= self.starts_at:
            raise ValueError("活动结束时间必须晚于开始时间")
        return self


def init_schema():
    with db.conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS v7_campaigns(
          id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL, actor_id INTEGER, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS v7_invite_links(
          user_id INTEGER PRIMARY KEY REFERENCES users(id), code TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS v7_guest_referrals(
          guest_id INTEGER PRIMARY KEY REFERENCES guests(id), inviter_id INTEGER NOT NULL REFERENCES users(id),
          campaign_id INTEGER NOT NULL REFERENCES v7_campaigns(id), created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, registered_user_id INTEGER REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS v7_referrals(
          id INTEGER PRIMARY KEY AUTOINCREMENT, inviter_id INTEGER NOT NULL REFERENCES users(id),
          invitee_id INTEGER NOT NULL UNIQUE REFERENCES users(id), campaign_id INTEGER NOT NULL REFERENCES v7_campaigns(id),
          status TEXT NOT NULL, created_at INTEGER NOT NULL, min_draw_id INTEGER NOT NULL,
          qualified_at INTEGER, reward_month TEXT, rewarded_at INTEGER, reason TEXT NOT NULL DEFAULT '',
          CHECK(inviter_id<>invitee_id));
        CREATE INDEX IF NOT EXISTS idx_v7_referrals_owner ON v7_referrals(inviter_id,id DESC);
        CREATE INDEX IF NOT EXISTS idx_v7_referrals_month ON v7_referrals(inviter_id,reward_month);
        CREATE TABLE IF NOT EXISTS v7_reward_grants(
          id INTEGER PRIMARY KEY AUTOINCREMENT, referral_id INTEGER NOT NULL REFERENCES v7_referrals(id),
          owner TEXT NOT NULL, feature TEXT NOT NULL, days INTEGER NOT NULL,
          source TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
          UNIQUE(referral_id,owner,feature));
        CREATE TABLE IF NOT EXISTS v7_metrics(
          day TEXT NOT NULL, subject TEXT NOT NULL, event TEXT NOT NULL,
          first_at INTEGER,
          PRIMARY KEY(day,subject,event));
        """)
        columns = {row['name'] for row in c.execute('PRAGMA table_info(v7_metrics)')}
        if 'first_at' not in columns:
            c.execute('ALTER TABLE v7_metrics ADD COLUMN first_at INTEGER')
        columns = {row['name'] for row in c.execute('PRAGMA table_info(v7_referrals)')}
        for name,ddl in {'manual_hold':'INTEGER NOT NULL DEFAULT 0', 'review_note':"TEXT NOT NULL DEFAULT ''",
                         'reviewed_at':'INTEGER', 'review_actor_id':'INTEGER'}.items():
            if name not in columns:
                c.execute(f'ALTER TABLE v7_referrals ADD COLUMN {name} {ddl}')
        c.execute("INSERT OR IGNORE INTO v7_campaigns(version,payload,reason,created_at) VALUES(1,?,'initial',?)",
                  (json.dumps(CampaignInput().model_dump(), ensure_ascii=False), int(time.time())))


def _campaign(row):
    return {**json.loads(row["payload"]), "id": row["id"], "version": row["version"]}


def _current(c):
    return _campaign(c.execute("SELECT * FROM v7_campaigns ORDER BY version DESC LIMIT 1").fetchone())


def current_campaign():
    with db.conn() as c:
        return _current(c)


def _open(config, now):
    return config["enabled"] and (config["starts_at"] is None or now >= config["starts_at"]) and (config["ends_at"] is None or now <= config["ends_at"])


def public_campaign():
    config = current_campaign()
    return config if _open(config, int(time.time())) else None


def skins():
    with db.conn() as c:
        return [{"feature": product["feature"], "name": product["name"]}
                for slug,product in payments.CATALOG.items() if product.get("kind") == "skin" and commerce.product_metadata(c,slug,product)['giftable']]


def audit(c, actor, action, target, detail):
    c.execute("INSERT INTO admin_audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)",
              (actor, action, target, json.dumps(detail, ensure_ascii=False), datetime.now().isoformat(timespec="seconds")))


def update_campaign(config: CampaignInput, actor: int, reason: str, *, expected_version: int | None = None):
    if not 2 <= len(reason.strip()) <= 200:
        raise DomainError("请填写 2 至 200 字的调整原因")
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        previous = _current(c)
        if expected_version is not None and previous['version'] != expected_version:
            raise DomainError('邀请活动已更新，请重新读取当前规则后再发布；本次修改尚未保存。', 409)
        choices = {product['feature']:{**product,**commerce.product_metadata(c,slug,product)} for slug,product in payments.CATALOG.items()}
        skin = choices.get(config.skin_feature)
        if config.skin_feature and (not skin or skin.get('kind')!='skin' or (config.enabled and not skin['giftable'])):
            raise DomainError('请选择已交付、允许新邀请规则赠送的皮肤')
        if config.enabled and not choices.get('pro',{}).get('giftable'):
            raise DomainError('专业会员已停止用于新邀请规则，请先调整商品赠送设置')
        version = previous["version"] + 1
        c.execute("INSERT INTO v7_campaigns(version,payload,actor_id,reason,created_at) VALUES(?,?,?,?,?)",
                  (version, json.dumps(config.model_dump(), ensure_ascii=False), actor, reason.strip(), int(time.time())))
        result = _current(c)
        audit(c, actor, "referral_campaign", f"campaign:{result['id']}", {"before": previous, "after": result, "reason": reason.strip()})
        return result


def ensure_code(uid: int):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        user = c.execute("SELECT status FROM users WHERE id=?", (uid,)).fetchone()
        if not user or user["status"] != "active":
            raise DomainError("账号不可参与邀请", 403)
        c.execute("INSERT OR IGNORE INTO v7_invite_links VALUES(?,?,?)", (uid, secrets.token_urlsafe(18), int(time.time())))
        return c.execute("SELECT code FROM v7_invite_links WHERE user_id=?", (uid,)).fetchone()[0]


def attribute(guest_id: int, code: str):
    now = int(time.time())
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        previous = c.execute("SELECT * FROM v7_guest_referrals WHERE guest_id=?", (guest_id,)).fetchone()
        if previous and previous["registered_user_id"]:
            return {"attributed": False, "campaign": None}
        # First valid attribution wins, even when a newer campaign/link is visited.
        if previous and previous["expires_at"] >= now:
            campaign = _campaign(c.execute("SELECT * FROM v7_campaigns WHERE id=?", (previous["campaign_id"],)).fetchone())
            return {"attributed": True, "campaign": campaign}
        campaign = _current(c)
        inviter = c.execute("SELECT l.user_id FROM v7_invite_links l JOIN users u ON u.id=l.user_id WHERE l.code=? AND u.status='active'", (code,)).fetchone()
        if not inviter or not _open(campaign, now):
            return {"attributed": False, "campaign": None}
        end = now + campaign["attribution_days"] * 86400
        if campaign["ends_at"] is not None:
            end = min(end, campaign["ends_at"])
        c.execute("""INSERT INTO v7_guest_referrals VALUES(?,?,?,?,?,NULL)
            ON CONFLICT(guest_id) DO UPDATE SET inviter_id=excluded.inviter_id,campaign_id=excluded.campaign_id,
            created_at=excluded.created_at,expires_at=excluded.expires_at""",
                  (guest_id, inviter["user_id"], campaign["id"], now, end))
        return {"attributed": True, "campaign": campaign}


def register_created(c, uid: int, guest_id: int | None):
    """Run inside the NEW user INSERT transaction, never exposed as an API."""
    if guest_id is None:
        return
    now = int(time.time())
    pending = c.execute("SELECT * FROM v7_guest_referrals WHERE guest_id=?", (guest_id,)).fetchone()
    if not pending or pending["registered_user_id"] is not None or pending["expires_at"] < now or pending["inviter_id"] == uid:
        return
    last_draw = c.execute("SELECT COALESCE(MAX(id),0) FROM v6_draws").fetchone()[0]
    cursor = c.execute("""INSERT INTO v7_referrals(inviter_id,invitee_id,campaign_id,status,created_at,min_draw_id)
        VALUES(?,?,?,'pending',?,?)""", (pending["inviter_id"], uid, pending["campaign_id"], now, last_draw))
    c.execute("UPDATE v7_guest_referrals SET registered_user_id=? WHERE guest_id=?", (uid, guest_id))
    _qualify(c, cursor.lastrowid, now)


def _grant(c, referral_id, uid, feature, days, now):
    owner = f"user:{uid}"
    source = f"invite:{referral_id}:{uid}:{feature}"
    inserted = c.execute("""INSERT OR IGNORE INTO v7_reward_grants(referral_id,owner,feature,days,source,created_at)
        VALUES(?,?,?,?,?,?)""", (referral_id, owner, feature, days, source, now)).rowcount
    if not inserted:
        return
    end = commerce.current_expiry(c, owner, feature, now)
    expiry = None if end is None else end + days * 86400
    c.execute("INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,?,?)", (owner, feature, expiry, source))


def _qualify(c, referral_id, now):
    row = c.execute("SELECT * FROM v7_referrals WHERE id=?", (referral_id,)).fetchone()
    if not row or row["status"] in {"rewarded", "revoked", "capped"}:
        return
    if row['manual_hold']:
        c.execute("UPDATE v7_referrals SET status='held',reason='人工核验中，暂缓发放' WHERE id=?",(referral_id,))
        return
    campaign = _campaign(c.execute("SELECT * FROM v7_campaigns WHERE id=?", (row["campaign_id"],)).fetchone())
    active_users = c.execute("SELECT COUNT(*) FROM users WHERE id IN (?,?) AND status='active'", (row["inviter_id"], row["invitee_id"])).fetchone()[0]
    if active_users != 2:
        c.execute("UPDATE v7_referrals SET status='held',reason='关联账号不可用，等待核验' WHERE id=?", (referral_id,))
        return
    if campaign["require_experience"]:
        experienced = c.execute("""SELECT 1 FROM v6_draws d JOIN v6_runs r ON r.id=d.run_id
            WHERE r.owner=? AND r.rehearsal=0 AND d.id>? LIMIT 1""", (f"user:{row['invitee_id']}", row["min_draw_id"])).fetchone()
        if not experienced:
            c.execute("UPDATE v7_referrals SET status='pending',reason='等待新朋友完成一次正式体验' WHERE id=?", (referral_id,))
            return
    month = row["reward_month"] or datetime.fromtimestamp(now, CHINA).strftime("%Y-%m")
    count = c.execute("SELECT COUNT(*) FROM v7_referrals WHERE inviter_id=? AND reward_month=? AND rewarded_at IS NOT NULL",
                      (row["inviter_id"], month)).fetchone()[0]
    c.execute("UPDATE v7_referrals SET qualified_at=COALESCE(qualified_at,?),reward_month=? WHERE id=?", (now, month, referral_id))
    if count >= campaign["monthly_cap"]:
        c.execute("UPDATE v7_referrals SET status='capped',reason='资格达成当月奖励已达上限' WHERE id=?", (referral_id,))
        return
    recipients = [row["inviter_id"]] + ([row["invitee_id"]] if campaign["reward_newcomer"] else [])
    for uid in recipients:
        _grant(c, referral_id, uid, "pro", campaign["pro_days"], now)
        if campaign["skin_feature"]:
            _grant(c, referral_id, uid, campaign["skin_feature"], campaign["skin_days"], now)
    c.execute("UPDATE v7_referrals SET status='rewarded',rewarded_at=?,reason='' WHERE id=?", (now, referral_id))


def qualify_user(uid: int):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT id FROM v7_referrals WHERE invitee_id=?", (uid,)).fetchone()
        if row:
            _qualify(c, row["id"], int(time.time()))


def retry_pending(inviter_id: int | None = None, limit: int = 200):
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        query, args = "SELECT id FROM v7_referrals WHERE status IN ('pending','held') AND manual_hold=0", []
        if inviter_id is not None:
            query += " AND inviter_id=?"
            args.append(inviter_id)
        rows = c.execute(query + " ORDER BY id LIMIT ?", (*args, limit)).fetchall()
        now = int(time.time())
        for row in rows:
            _qualify(c, row["id"], now)
        states = [c.execute('SELECT status FROM v7_referrals WHERE id=?',(row['id'],)).fetchone()[0] for row in rows]
        return {'checked':len(rows),'rewarded':states.count('rewarded'),
                'pending':states.count('pending'),'held':states.count('held'),'capped':states.count('capped')}


def _record(row, private=False):
    config = json.loads(row["payload"])
    base = {key: row[key] for key in ("id", "status", "created_at", "rewarded_at", "reason")}
    base.update({key: config[key] for key in ("pro_days", "skin_feature", "skin_days")})
    if private:
        base.update({key: row[key] for key in ("inviter_id", "inviter_name", "invitee_id", "invitee_name", "campaign_version")})
        base.update(manual_hold=bool(row['manual_hold']),review_note=row['review_note'],reviewed_at=row['reviewed_at'],review_actor_id=row['review_actor_id'])
    else:
        base["invitee_label"] = row["invitee_name"][:1] + "***"
        base['reason'] = {'pending':'等待注册后的体验条件', 'held':'奖励资格核验中', 'rewarded':'',
                          'revoked':'该邀请奖励已撤销', 'capped':'资格达成当月奖励已达上限'}.get(row['status'],'')
    return base


JOIN_RECORDS = """FROM v7_referrals r JOIN v7_campaigns c ON c.id=r.campaign_id
    JOIN users a ON a.id=r.inviter_id JOIN users b ON b.id=r.invitee_id"""
SELECT_RECORDS = "SELECT r.*,c.payload,c.version campaign_version,a.custom_id inviter_name,b.custom_id invitee_name " + JOIN_RECORDS


def mine(uid: int):
    code = ensure_code(uid)
    retry_pending(uid)
    month = datetime.fromtimestamp(time.time(), CHINA).strftime("%Y-%m")
    with db.conn() as c:
        rows = c.execute(SELECT_RECORDS + " WHERE r.inviter_id=? ORDER BY r.id DESC LIMIT 100", (uid,)).fetchall()
        count = c.execute("SELECT COUNT(*) FROM v7_referrals WHERE inviter_id=? AND reward_month=? AND rewarded_at IS NOT NULL", (uid, month)).fetchone()[0]
    return {"code": code, "link_path": "/login.html?invite=" + code, "campaign": public_campaign(),
            "completed_this_month": count, "records": [_record(row) for row in rows]}


def list_records(q="", status="", page=1, page_size=25, needs_review=False, user_id=None):
    if len(q)>80 or status not in {"", "pending", "held", "rewarded", "revoked", "capped"} or page<1 or not 1<=page_size<=100:
        raise DomainError("邀请查询条件无效")
    terms, params = [], []
    if q:
        terms.append("(instr(a.custom_id,?)>0 OR instr(b.custom_id,?)>0 OR CAST(r.inviter_id AS TEXT)=? OR CAST(r.invitee_id AS TEXT)=?)")
        params += [q]*4
    if status:
        terms.append("r.status=?")
        params.append(status)
    if needs_review:
        terms.append('r.manual_hold=1')
    if user_id is not None:
        terms.append('(r.inviter_id=? OR r.invitee_id=?)')
        params += [user_id,user_id]
    where = " WHERE " + " AND ".join(terms) if terms else ""
    with db.conn() as c:
        total = c.execute("SELECT COUNT(*) " + JOIN_RECORDS + where, params).fetchone()[0]
        pages = max(1, (total+page_size-1)//page_size)
        page = min(page,pages)
        rows = c.execute(SELECT_RECORDS + where + " ORDER BY r.id DESC LIMIT ? OFFSET ?", (*params, page_size, (page-1)*page_size)).fetchall()
    records = [_record(row,True) for row in rows]
    if user_id is not None:
        for record in records:
            record['relationship'] = 'inviter' if record['inviter_id']==user_id else 'invitee'
    return {"records": records, "total": total, "page": page, "pages": pages}


def review(referral_id, action, reason, actor):
    if action not in {"retry", "revoke", "hold", "release"} or not 2 <= len(reason.strip()) <= 200:
        raise DomainError("请选择操作并填写 2 至 200 字原因")
    now = int(time.time())
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT * FROM v7_referrals WHERE id=?", (referral_id,)).fetchone()
        if not row:
            raise DomainError("邀请记录不存在",404)
        if action == "retry":
            if row["status"] == "revoked":
                raise DomainError("已撤销的邀请奖励不能再次发放",409)
            if row['manual_hold']:
                raise DomainError('该记录已人工标记，请先解除核验标记后再评估发奖',409)
            _qualify(c,referral_id,now)
        elif action in {'hold','release'}:
            if row['status']=='revoked':
                raise DomainError('已撤销的邀请无需再次核验',409)
            hold = action=='hold'
            if bool(row['manual_hold'])==hold and (not hold or row['review_note']==reason.strip()):
                return _record(c.execute(SELECT_RECORDS+' WHERE r.id=?',(referral_id,)).fetchone(),True)
            c.execute('UPDATE v7_referrals SET manual_hold=?,review_note=?,reviewed_at=?,review_actor_id=? WHERE id=?',
                      (int(hold),reason.strip(),now,actor,referral_id))
            # Flagging an already delivered gift does not silently take it away.
            # Pending gifts are paused until a human explicitly releases them.
            _qualify(c,referral_id,now)
        else:
            grants = c.execute("SELECT * FROM v7_reward_grants WHERE referral_id=?", (referral_id,)).fetchall()
            for grant in grants:
                c.execute("INSERT OR IGNORE INTO v6_entitlement_revocations(source,owner,feature,reason,created_at) VALUES(?,?,?,?,?)",
                          (grant["source"], grant["owner"], grant["feature"], reason.strip(), now))
            for owner, feature in {(grant["owner"],grant["feature"]) for grant in grants}:
                commerce.recompute_feature(c,owner,feature)
            c.execute("UPDATE v7_referrals SET status='revoked',reason=?,manual_hold=0,review_note=?,reviewed_at=?,review_actor_id=? WHERE id=?",
                      (reason.strip(),reason.strip(),now,actor,referral_id))
        audit(c,actor,"referral_"+action,f"referral:{referral_id}",{"reason":reason.strip(),"previous_status":row["status"],"previous_hold":bool(row['manual_hold']),"previous_note":row['review_note']})
        return _record(c.execute(SELECT_RECORDS+" WHERE r.id=?",(referral_id,)).fetchone(),True)
