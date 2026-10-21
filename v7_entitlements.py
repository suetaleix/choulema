"""Auditable manual compensation as an independent entitlement source."""
import secrets
import time

import db
import v6_commerce as commerce
import v6_payments as payments
import v7_referrals as referrals
from v6_engine import DomainError


def init_schema():
    with db.conn() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS v7_manual_grants(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL, feature TEXT NOT NULL, days INTEGER NOT NULL,
            source TEXT NOT NULL UNIQUE, actor_id INTEGER NOT NULL REFERENCES users(id),
            reason TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
            UNIQUE(actor_id,request_id))''')


def grant(uid,feature,days,reason,request_id,actor_id):
    if feature not in {p['feature'] for p in payments.CATALOG.values()}:
        raise DomainError('请选择已交付的会员或皮肤权益')
    if isinstance(days,bool) or not isinstance(days,int) or not 1<=days<=3650:
        raise DomainError('补偿期限应为 1 至 3650 天')
    if not 2<=len(reason.strip())<=200:
        raise DomainError('请填写 2 至 200 字的补偿原因')
    owner,now = f'user:{uid}',int(time.time())
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        prior = c.execute('SELECT * FROM v7_manual_grants WHERE actor_id=? AND request_id=?',(actor_id,request_id)).fetchone()
        if prior:
            if (prior['owner'],prior['feature'],prior['days'],prior['reason']) != (owner,feature,days,reason.strip()):
                raise DomainError('同一补偿请求不能更换账号、权益、期限或原因',409)
            return {**dict(prior),'already_created':True}
        user = c.execute('SELECT role,status FROM users WHERE id=?',(uid,)).fetchone()
        if not user:
            raise DomainError('账号不存在',404)
        if user['status']!='active' or user['role']=='superadmin':
            raise DomainError('仅能向正常普通账号发放补偿')
        source = 'admin:v7:'+secrets.token_hex(16)
        end = commerce.current_expiry(c,owner,feature,now)
        expiry = None if end is None else end+days*86400
        c.execute('''INSERT INTO v7_manual_grants(owner,feature,days,source,actor_id,reason,request_id,created_at)
            VALUES(?,?,?,?,?,?,?,?)''',(owner,feature,days,source,actor_id,reason.strip(),request_id,now))
        c.execute('INSERT INTO v6_entitlements(owner,feature,expires_at,source) VALUES(?,?,?,?)',(owner,feature,expiry,source))
        row = dict(c.execute('SELECT * FROM v7_manual_grants WHERE source=?',(source,)).fetchone())
        referrals.audit(c,actor_id,'manual_grant',source,{'owner':owner,'feature':feature,'days':days,'reason':reason.strip()})
    return {**row,'already_created':False}


def revoke(grant_id,reason,actor_id):
    if not 2<=len(reason.strip())<=200:
        raise DomainError('请填写 2 至 200 字的撤销原因')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT * FROM v7_manual_grants WHERE id=?',(grant_id,)).fetchone()
        if not row:
            raise DomainError('补偿来源不存在',404)
        previous = c.execute('SELECT 1 FROM v6_entitlement_revocations WHERE owner=? AND feature=? AND source=?',
                             (row['owner'],row['feature'],row['source'])).fetchone()
        if previous:
            return {'id':grant_id,'already_revoked':True}
        c.execute('INSERT INTO v6_entitlement_revocations(source,owner,feature,reason,created_at) VALUES(?,?,?,?,?)',
                  (row['source'],row['owner'],row['feature'],reason.strip(),int(time.time())))
        commerce.recompute_feature(c,row['owner'],row['feature'])
        referrals.audit(c,actor_id,'manual_grant_revoke',row['source'],{'owner':row['owner'],'feature':row['feature'],'days':row['days'],'reason':reason.strip()})
    return {'id':grant_id,'already_revoked':False}
