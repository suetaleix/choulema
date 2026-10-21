"""Private feedback inbox. Text only; no rosters, uploads or automatic email delivery."""
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

import db
from email_auth import normalize_email, EmailError
from v6_engine import DomainError
from v7_referrals import audit


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Context(Input):
    page: Literal['login', 'play']
    app: Literal['', 'food', 'play', 'prize', 'person'] = ''
    machine: Literal['', 'wheel', 'capsule', 'sphere'] = ''
    theme: Literal['', 'classic', 'cosmic'] = ''
    width: int = Field(default=0, ge=0, le=10000, strict=True)
    height: int = Field(default=0, ge=0, le=10000, strict=True)


class FeedbackIn(Input):
    request_id: str = Field(min_length=16, max_length=80, pattern=r'^[A-Za-z0-9_-]+$')
    category: Literal['bug', 'suggestion', 'other']
    content: str = Field(min_length=5, max_length=2000)
    contact_email: str = Field(default='', max_length=254)
    context: Context | None = None
    scope: str = Field(default='', max_length=64)


class UpdateIn(Input):
    revision: int = Field(ge=1, strict=True)
    status: Literal['new', 'reviewing', 'planned', 'resolved', 'closed']
    reply: str = Field(default='', max_length=2000)
    internal_note: str = Field(default='', max_length=1000)


def init_schema(c):
    c.execute('''CREATE TABLE IF NOT EXISTS v8_feedback(
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL,
        contact_email TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'new', revision INTEGER NOT NULL DEFAULT 1,
        ip_hash TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(owner,request_id))''')
    c.execute('CREATE INDEX IF NOT EXISTS v8_feedback_owner ON v8_feedback(owner,created_at)')
    c.execute('CREATE INDEX IF NOT EXISTS v8_feedback_status ON v8_feedback(status,created_at)')
    c.execute('CREATE INDEX IF NOT EXISTS v8_feedback_ip ON v8_feedback(ip_hash,created_at)')
    c.execute('''CREATE TABLE IF NOT EXISTS v8_feedback_replies(
        id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id TEXT NOT NULL REFERENCES v8_feedback(id),
        actor_id INTEGER NOT NULL, reply TEXT NOT NULL, internal_note TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL)''')
    c.execute('CREATE INDEX IF NOT EXISTS v8_feedback_reply_ticket ON v8_feedback_replies(feedback_id,id)')
    c.execute("INSERT OR IGNORE INTO settings(k,v) VALUES('feedback_hash_key',?)", (secrets.token_hex(32),))
    # Keep the legacy table intact and import each historical message exactly once.
    for row in c.execute('SELECT * FROM feedback'):
        try:
            timestamp = int(datetime.fromisoformat(row['created_at']).timestamp())
        except (ValueError, TypeError):
            timestamp = 0
        c.execute('''INSERT OR IGNORE INTO v8_feedback
            (id,owner,request_id,payload_hash,category,content,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)''', (f"legacy_{row['id']}", f"{row['subject_type']}:{row['subject_id']}",
                f"legacy_{row['id']}", '', 'other', row['content'], timestamp, timestamp))


def identity(req, current_user, current_subject):
    # Invalid/disabled authenticated sessions must never silently become guests.
    if req.cookies.get('sid') or req.headers.get('Authorization'):
        return f"user:{current_user(req)['id']}"
    subject = current_subject(req)
    if not subject:
        raise DomainError('请刷新页面后重试', 401)
    return f"{subject['kind']}:{subject['id']}"


def scopes(c, owner):
    if owner.startswith('guest:'):
        if c.execute('SELECT 1 FROM v6_guest_handoffs WHERE guest_scope=?', (owner,)).fetchone():
            raise DomainError('该浏览器的反馈已归入登录账号，请刷新后重试', 403)
        return [owner]
    return [owner] + [r[0] for r in c.execute('SELECT guest_scope FROM v6_guest_handoffs WHERE owner=?', (owner,))]


def digest(c, text):
    key = c.execute("SELECT v FROM settings WHERE k='feedback_hash_key'").fetchone()[0]
    return hmac.new(key.encode(), text.encode(), hashlib.sha256).hexdigest()


def public_ticket(c, row, admin=False):
    result = {k: row[k] for k in ('id', 'category', 'content', 'status', 'revision', 'created_at', 'updated_at')}
    result['context'] = json.loads(row['context_json'])
    result['replies'] = []
    for r in c.execute('SELECT * FROM v8_feedback_replies WHERE feedback_id=? ORDER BY id', (row['id'],)):
        item = {k: r[k] for k in ('reply', 'status', 'created_at')}
        if admin:
            item.update(internal_note=r['internal_note'], actor_id=r['actor_id'])
        result['replies'].append(item)
    if admin:
        result.update(owner=row['owner'], contact_email=row['contact_email'])
        uid = row['owner'].split(':', 1)[1] if row['owner'].startswith('user:') else None
        if uid is None:
            handoff = c.execute('SELECT owner FROM v6_guest_handoffs WHERE guest_scope=?', (row['owner'],)).fetchone()
            if handoff:
                uid = handoff[0].split(':', 1)[1]
        user = c.execute('SELECT custom_id,email FROM users WHERE id=?', (uid,)).fetchone() if uid else None
        result['account'] = (user['email'] or user['custom_id']) if user else '游客'
    return result


def submit(owner, body, ip):
    try:
        email = normalize_email(body.contact_email) if body.contact_email else ''
    except EmailError as exc:
        raise DomainError(str(exc)) from None
    if any(ord(char) < 32 and char not in '\n\r\t' for char in body.content):
        raise DomainError('反馈包含无效字符')
    payload = body.model_dump(exclude={'request_id', 'scope'})
    payload['contact_email'] = email
    payload_hash = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    now = int(time.time())
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        owners = scopes(c, owner)
        if body.scope and not hmac.compare_digest(body.scope, digest(c, 'owner:' + owner)):
            raise DomainError('登录身份已变化，请关闭后重新打开反馈', 409)
        placeholders = ','.join('?' for _ in owners)
        existing = c.execute(f'SELECT * FROM v8_feedback WHERE owner IN ({placeholders}) AND request_id=?', (*owners, body.request_id)).fetchone()
        if existing:
            if existing['payload_hash'] != payload_hash:
                raise DomainError('这次提交的内容已改变，请重新提交', 409)
            return {'feedback': public_ticket(c, existing), 'duplicate': True}
        ip_hash = digest(c, 'ip:' + ip)
        recent = c.execute(f'SELECT COUNT(*),MAX(created_at) FROM v8_feedback WHERE owner IN ({placeholders}) AND created_at>?', (*owners, now-86400)).fetchone()
        if recent[0] >= 5:
            raise DomainError('24 小时内最多提交 5 条反馈，请稍后再试', 429)
        if recent[1] is not None and recent[1] > now-30:
            raise DomainError('反馈已收到，请间隔 30 秒后再提交新反馈', 429)
        if c.execute('SELECT COUNT(*) FROM v8_feedback WHERE ip_hash=? AND created_at>?', (ip_hash, now-86400)).fetchone()[0] >= 20:
            raise DomainError('当前网络提交较频繁，请稍后再试', 429)
        if c.execute('SELECT COUNT(*) FROM v8_feedback WHERE created_at>?', (now-86400,)).fetchone()[0] >= 1000:
            raise DomainError('反馈收件箱繁忙，请稍后再试', 429)
        ticket_id = 'fb_' + secrets.token_hex(12)
        c.execute('''INSERT INTO v8_feedback(id,owner,request_id,payload_hash,category,content,contact_email,context_json,ip_hash,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (ticket_id, owner, body.request_id, payload_hash, body.category,
                body.content, email, json.dumps(payload['context'] or {}, ensure_ascii=False), ip_hash, now, now))
        return {'feedback': public_ticket(c, c.execute('SELECT * FROM v8_feedback WHERE id=?', (ticket_id,)).fetchone()), 'duplicate': False}


def list_own(owner, page=1):
    with db.conn() as c:
        owners = scopes(c, owner)
        where = 'owner IN (' + ','.join('?' for _ in owners) + ')'
        total = c.execute('SELECT COUNT(*) FROM v8_feedback WHERE ' + where, owners).fetchone()[0]
        pages = max(1, (total+9)//10)
        page = min(page, pages)
        rows = c.execute('SELECT * FROM v8_feedback WHERE ' + where + ' ORDER BY created_at DESC,id DESC LIMIT 10 OFFSET ?', (*owners, (page-1)*10)).fetchall()
        return {'items': [public_ticket(c, r) for r in rows], 'page': page, 'pages': pages, 'total': total,
                'scope': digest(c, 'owner:' + owner), 'guest': owner.startswith('guest:')}


def counts():
    with db.conn() as c:
        return {r[0]: r[1] for r in c.execute('SELECT status,COUNT(*) FROM v8_feedback GROUP BY status')}


def admin_list(status='', category='', q='', page=1):
    conditions, values = ['1=1'], []
    for key, value in (('status', status), ('category', category)):
        if value:
            conditions.append(f'{key}=?')
            values.append(value)
    if q:
        conditions.append('(instr(content,?)>0 OR instr(id,?)>0 OR instr(contact_email,?)>0)')
        values.extend([q]*3)
    where = ' AND '.join(conditions)
    with db.conn() as c:
        total = c.execute('SELECT COUNT(*) FROM v8_feedback WHERE ' + where, values).fetchone()[0]
        pages = max(1, (total+24)//25)
        page = min(page, pages)
        rows = c.execute('SELECT * FROM v8_feedback WHERE ' + where + ' ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET ?', (*values, (page-1)*25)).fetchall()
        return {'items': [public_ticket(c, r, True) for r in rows], 'total': total, 'page': page, 'pages': pages, 'counts': counts()}


def update(ticket_id, body, actor):
    if body.status in {'resolved', 'closed'} and not body.reply:
        raise DomainError('解决或关闭反馈前，请填写给用户的处理说明')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT * FROM v8_feedback WHERE id=?', (ticket_id,)).fetchone()
        if not row:
            raise DomainError('反馈不存在', 404)
        if row['revision'] != body.revision:
            raise DomainError('反馈已更新，请重新打开详情核对，避免重复回复', 409)
        if row['status'] == body.status and not body.reply and not body.internal_note:
            raise DomainError('请调整状态或填写回复、内部备注')
        now = int(time.time())
        c.execute('UPDATE v8_feedback SET status=?,revision=revision+1,updated_at=? WHERE id=?', (body.status, now, ticket_id))
        c.execute('INSERT INTO v8_feedback_replies(feedback_id,actor_id,reply,internal_note,status,created_at) VALUES(?,?,?,?,?,?)',
                  (ticket_id, actor, body.reply, body.internal_note, body.status, now))
        audit(c, actor, 'feedback_update', ticket_id, {'before': row['status'], 'after': body.status,
              'has_reply': bool(body.reply), 'has_internal_note': bool(body.internal_note)})
        return {'feedback': public_ticket(c, c.execute('SELECT * FROM v8_feedback WHERE id=?', (ticket_id,)).fetchone(), True)}


def install(app, current_user, current_subject):
    router = APIRouter(prefix='/api/v7')

    def admin(req):
        actor = current_user(req)
        if actor['role'] != 'superadmin':
            raise DomainError('无权限', 403)
        return actor['id']

    @router.post('/feedback')
    def create(body: FeedbackIn, req: Request):
        return submit(identity(req, current_user, current_subject), body, req.client.host if req.client else '')

    @router.get('/feedback')
    def mine(req: Request, page: int = Query(default=1, ge=1, le=100000)):
        return list_own(identity(req, current_user, current_subject), page)

    @router.get('/admin/feedback')
    def inbox(req: Request, status: Literal['', 'new', 'reviewing', 'planned', 'resolved', 'closed'] = '',
              category: Literal['', 'bug', 'suggestion', 'other'] = '', q: str = Query(default='', max_length=200),
              page: int = Query(default=1, ge=1, le=100000)):
        admin(req)
        return admin_list(status, category, q.strip(), page)

    @router.get('/admin/feedback/{ticket_id}')
    def detail(ticket_id: str, req: Request):
        admin(req)
        with db.conn() as c:
            row = c.execute('SELECT * FROM v8_feedback WHERE id=?', (ticket_id,)).fetchone()
            if not row:
                raise DomainError('反馈不存在', 404)
            return {'feedback': public_ticket(c, row, True)}

    @router.put('/admin/feedback/{ticket_id}')
    def save(ticket_id: str, body: UpdateIn, req: Request):
        return update(ticket_id, body, admin(req))

    app.include_router(router)
