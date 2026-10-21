from concurrent.futures import ThreadPoolExecutor
import json
import time

import pytest
from fastapi.testclient import TestClient

import db
import server
import v6_commerce as commerce
import v6_engine as engine
import v6_payments as payments
import v7_entitlements as manual


def user(number,admin=False):
    phone=f'136{number:08d}'
    assert db.create_user(phone,f'grantUser{number}','test-password')[0]
    uid=db.authenticate(phone,'test-password')['id']
    if admin:
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?",(uid,))
    return uid,phone


def test_manual_revoke_rebases_paid_and_card_terms_without_losing_them(monkeypatch):
    uid,_=user(1)
    admin,_=user(2,True)
    owner=f'user:{uid}'
    now=int(time.time())
    monkeypatch.setattr(manual.time,'time',lambda:now)
    snapshot=json.dumps({'provider':'alipay','feature':'pro','days':365})
    with db.conn() as c:
        c.execute('''INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,created_at,paid_at)
            VALUES('confirmed-order',?,'one',?,9900,'paid',?,?)''',(owner,snapshot,now,now))
        c.execute('INSERT INTO v6_entitlements VALUES(?,?,?,?)',(owner,'pro',now+365*86400,'confirmed-order'))
    gift=manual.grant(uid,'pro',30,'服务补偿','request-one-00001',admin)
    code=commerce.generate_cards('pro',90,1,'季度卡','测试',None,admin,payments.CATALOG)['codes'][0]
    commerce.redeem_card(code,uid)
    assert commerce.entitlement_details(owner)['features']['pro']['expires_at']==now+485*86400
    assert manual.revoke(gift['id'],'撤销误发补偿',admin)['already_revoked'] is False
    assert commerce.entitlement_details(owner)['features']['pro']['expires_at']==now+455*86400
    assert manual.revoke(gift['id'],'再次核对撤销',admin)['already_revoked'] is True
    assert manual.grant(uid,'pro',30,'服务补偿','request-one-00001',admin)['already_created'] is True
    assert commerce.entitlement_details(owner)['features']['pro']['expires_at']==now+455*86400
    sources=commerce.entitlement_details(owner)['sources']
    assert sum(bool(s.get('manual_grant_id')) for s in sources)==1
    assert all(not s['revoked'] for s in sources if s['source_kind'] in ('online','card'))


def test_refunded_payment_recompute_retains_original_manual_duration(monkeypatch):
    uid,_=user(3)
    admin,_=user(4,True)
    owner=f'user:{uid}'
    now=int(time.time())
    monkeypatch.setattr(manual.time,'time',lambda:now)
    with db.conn() as c:
        c.execute('''INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,created_at,paid_at)
            VALUES('paid-order',?,'one',?,9900,'paid',?,?)''',(owner,json.dumps({'provider':'alipay','feature':'pro','days':365}),now,now))
        c.execute('INSERT INTO v6_entitlements VALUES(?,?,?,?)',(owner,'pro',now+365*86400,'paid-order'))
    manual.grant(uid,'pro',30,'服务补偿','request-two-00001',admin)
    with db.conn() as c:
        c.execute("INSERT INTO v6_entitlement_revocations VALUES('paid-order',?,'pro','退款',?)",(owner,now))
        c.execute("UPDATE v6_orders SET state='refunded' WHERE order_no='paid-order'")
        commerce.recompute_feature(c,owner,'pro')
    assert commerce.entitlement_details(owner)['features']['pro']['expires_at']==now+30*86400


def test_concurrent_same_request_creates_one_source_and_rejects_changed_payload():
    uid,_=user(5)
    admin,_=user(6,True)
    args=(uid,'cosmic',30,'体验补偿','concurrent-key-0001',admin)
    with ThreadPoolExecutor(max_workers=5) as pool:
        results=list(pool.map(lambda _:manual.grant(*args),range(5)))
    assert sum(not r['already_created'] for r in results)==1
    assert len({r['source'] for r in results})==1
    with pytest.raises(engine.DomainError,match='同一补偿请求'):
        manual.grant(uid,'cosmic',90,'体验补偿','concurrent-key-0001',admin)
    with db.conn() as c:
        assert c.execute('SELECT COUNT(*) FROM v7_manual_grants').fetchone()[0]==1
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='manual_grant'").fetchone()[0]==1


def test_failed_grant_rolls_back_ledger_and_audit_then_allows_same_request_retry():
    uid,_=user(7)
    admin,_=user(8,True)
    with db.conn() as c:
        c.execute("""CREATE TRIGGER fail_manual BEFORE INSERT ON v6_entitlements
            WHEN NEW.source LIKE 'admin:v7:%' BEGIN SELECT RAISE(ABORT,'manual interrupted'); END""")
    with pytest.raises(Exception,match='manual interrupted'):
        manual.grant(uid,'pro',30,'重试补偿','rollback-key-0001',admin)
    with db.conn() as c:
        assert c.execute('SELECT COUNT(*) FROM v7_manual_grants').fetchone()[0]==0
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='manual_grant'").fetchone()[0]==0
        c.execute('DROP TRIGGER fail_manual')
    assert not manual.grant(uid,'pro',30,'重试补偿','rollback-key-0001',admin)['already_created']


def test_manual_api_permissions_validation_and_user_state():
    uid,phone=user(9)
    admin,admin_phone=user(10,True)
    body={'feature':'pro','days':30,'reason':'补偿服务中断','request_id':'manual-api-000001'}
    with TestClient(server.app) as client:
        path=f'/api/v7/admin/users/{uid}/grants'
        assert client.post(path,json=body).status_code==401
        client.post('/api/login',json={'phone':phone,'password':'test-password'})
        assert client.post(path,json=body).status_code==403
        client.post('/api/login',json={'phone':admin_phone,'password':'test-password'})
        for bad in ({**body,'days':True},{**body,'days':0},{**body,'days':3651},{**body,'reason':'  '}):
            assert client.post(path,json=bad).status_code==422
        assert client.post(path,json={**body,'feature':'unreleased-machine'}).status_code==400
        assert client.post(f'/api/v7/admin/users/{admin}/grants',json=body).status_code==400
        with db.conn() as c:
            c.execute("UPDATE users SET status='disabled' WHERE id=?",(uid,))
        assert client.post(path,json=body).status_code==400
        with db.conn() as c:
            c.execute("UPDATE users SET status='active' WHERE id=?",(uid,))
        response=client.post(path,json=body)
        assert response.status_code==200
        grant_id=response.json()['grant']['id']
        details=client.get(f'/api/v6/admin/users/{uid}/commerce').json()['entitlements']
        assert details['sources'][0]['manual_grant_id']==grant_id
        assert client.post(f'/api/v7/admin/grants/{grant_id}/revoke',json={'reason':'撤销误发'}).status_code==200
        assert 'pro' not in engine.features(f'user:{uid}')
