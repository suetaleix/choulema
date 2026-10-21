import json
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import db
import server
import v8_feedback as feedback
from v6_engine import DomainError


def user(client, number=1, admin=False):
    name=f'feedback{number}'
    assert db.create_user(f'1980000{number:04d}',name,'feedback-test-password')[0]
    uid=db.authenticate(name,'feedback-test-password')['id']
    if admin:
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?",(uid,))
    response=client.post('/api/login',json={'identifier':name,'password':'feedback-test-password'})
    assert response.status_code==200,response.text
    return uid


def payload(**changes):
    return dict(request_id=uuid.uuid4().hex,category='suggestion',content='希望增加一个机台主题筛选。',**changes)


def test_guest_user_admin_reply_and_private_notes():
    with TestClient(server.app) as guest, TestClient(server.app) as other, TestClient(server.app) as admin:
        first=guest.get('/api/v7/feedback').json()
        p=payload(scope=first['scope'],context={'page':'play','app':'food','machine':'capsule','theme':'cosmic','width':390,'height':844})
        created=guest.post('/api/v7/feedback',json=p)
        assert created.status_code==200,created.text
        ticket=created.json()['feedback']
        assert guest.post('/api/v7/feedback',json=p).json()['duplicate']
        assert other.get('/api/v7/feedback').json()['items']==[]
        uid=user(guest)
        assert guest.get('/api/v7/feedback').json()['items'][0]['id']==ticket['id']
        assert guest.get('/api/v7/admin/feedback').status_code==403
        admin_id=user(admin,2,True)
        result=admin.put('/api/v7/admin/feedback/'+ticket['id'],json={'revision':1,'status':'planned','reply':'已经采纳，计划加入后续版本。','internal_note':'内部优先级 P2，不可向用户透露。'})
        assert result.status_code==200,result.text
        owned=guest.get('/api/v7/feedback')
        assert owned.json()['items'][0]['status']=='planned'
        assert '已经采纳' in owned.text and '不可向用户透露' not in owned.text
        assert 'internal_note' not in owned.text and 'actor_id' not in owned.text and 'ip_hash' not in owned.text
        assert admin.get('/api/v7/admin/feedback?status=planned&category=suggestion&q=机台').json()['total']==1
        details=admin.get('/api/v7/admin/feedback/'+ticket['id']).json()['feedback']
        assert details['account']=='feedback1' and details['replies'][0]['actor_id']==admin_id
        assert admin.get('/api/v7/admin/overview').json()['feedback']['planned']==1
        with db.conn() as c:
            assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='feedback_update'").fetchone()[0]==1


def test_claimed_guest_cookie_cannot_read_or_submit_after_login():
    with TestClient(server.app) as client,TestClient(server.app) as stolen:
        client.get('/api/v7/feedback')
        old=client.cookies.get('gk')
        client.post('/api/v7/feedback',json=payload())
        user(client)
        stolen.cookies.set('gk',old)
        assert stolen.get('/api/v7/feedback').status_code==403
        assert stolen.post('/api/v7/feedback',json=payload()).status_code==403
        user(stolen,2)
        assert stolen.get('/api/v7/feedback').json()['items']==[]


@pytest.mark.parametrize('state',['disabled','banned','password','expired'])
def test_invalid_account_cannot_fall_back_to_guest(state):
    with TestClient(server.app) as client:
        uid=user(client)
        with db.conn() as c:
            if state=='password':c.execute('UPDATE users SET must_change_password=1 WHERE id=?',(uid,))
            elif state=='expired':c.execute('DELETE FROM sessions WHERE user_id=?',(uid,))
            else:c.execute('UPDATE users SET status=? WHERE id=?',(state,uid))
        assert client.post('/api/v7/feedback',json=payload()).status_code in (401,403)
        assert client.get('/api/v7/feedback').status_code in (401,403)


def test_status_revision_and_reply_required():
    with TestClient(server.app) as client:
        user(client,1,True)
        t=client.post('/api/v7/feedback',json=payload()).json()['feedback']
        url='/api/v7/admin/feedback/'+t['id']
        assert client.put(url,json={'revision':1,'status':'resolved'}).status_code==400
        body={'revision':1,'status':'resolved','reply':'已在本地修复，请刷新后再试。'}
        assert client.put(url,json=body).status_code==200
        assert client.put(url,json=body).status_code==409
        assert len(client.get(url).json()['feedback']['replies'])==1
        assert client.put(url,json={'revision':2,'status':'reviewing','reply':'重新跟进'}).status_code==200


def test_same_request_concurrent_is_exactly_once_and_changed_payload_rejected():
    body=feedback.FeedbackIn(**payload())
    with ThreadPoolExecutor(max_workers=6) as pool:
        results=list(pool.map(lambda _:feedback.submit('user:123',body,'127.0.0.1'),range(6)))
    assert len({r['feedback']['id'] for r in results})==1
    assert sum(not r['duplicate'] for r in results)==1
    with pytest.raises(DomainError) as exc:
        feedback.submit('user:123',body.model_copy(update={'content':'修改后的反馈描述内容'}),'127.0.0.1')
    assert exc.value.status==409


def test_limits_persist_across_restart_and_claimed_identity(monkeypatch):
    now=int(time.time())
    for i in range(5):
        monkeypatch.setattr(feedback.time,'time',lambda:now+i*31)
        feedback.submit('guest:1',feedback.FeedbackIn(**payload()),'local')
    db.init_db()
    with db.conn() as c:
        c.execute('INSERT INTO v6_guest_handoffs VALUES(?,?,?)',('guest:1','user:123',now))
    with pytest.raises(DomainError) as exc:
        feedback.submit('user:123',feedback.FeedbackIn(**payload()),'local')
    assert exc.value.status==429


def test_network_limit_and_cooldown():
    for i in range(20):feedback.submit(f'user:{i}',feedback.FeedbackIn(**payload()),'shared-ip')
    with pytest.raises(DomainError) as exc:feedback.submit('user:21',feedback.FeedbackIn(**payload()),'shared-ip')
    assert exc.value.status==429
    with pytest.raises(DomainError) as exc:feedback.submit('user:1',feedback.FeedbackIn(**payload()),'other-ip')
    assert exc.value.status==429


def test_legacy_feedback_preserved_once_and_old_endpoint_uses_new_limits():
    db.add_feedback('user',2,'历史反馈不应丢失',1)
    db.init_db();db.init_db()
    with db.conn() as c:
        assert c.execute('SELECT COUNT(*) FROM feedback').fetchone()[0]==1
        assert c.execute('SELECT COUNT(*) FROM v8_feedback').fetchone()[0]==1
    with TestClient(server.app) as client:
        client.get('/api/v7/feedback')
        assert client.post('/api/feedback',json={'content':'旧接口提交仍能看到'}).status_code==200
        assert client.get('/api/v7/feedback').json()['total']==1
        assert client.post('/api/v7/feedback',json=payload()).status_code==429


@pytest.mark.parametrize('changes',[{'category':'evil'},{'content':'    '},{'content':'x'*2001},{'owner':'user:1'}, {'context':{'page':'play','roster':['张三']}},{'context':{'page':'play','url':'https://secret/'}},{'context':{'page':'play','width':-1}},{'context':{'page':'play','width':True}}])
def test_rejects_invalid_payload(changes):
    with TestClient(server.app) as client:
        client.get('/api/v7/feedback')
        assert client.post('/api/v7/feedback',json={**payload(),**changes}).status_code==422


def test_scope_change_bad_email_csrf_body_limit_and_maintenance():
    with TestClient(server.app) as client:
        scope=client.get('/api/v7/feedback').json()['scope']
        user(client)
        assert client.post('/api/v7/feedback',json=payload(scope=scope)).status_code==409
        assert client.post('/api/v7/feedback',json=payload(contact_email='bad-address')).status_code==400
        assert client.post('/api/v7/feedback',json=payload(),headers={'Origin':'https://untrusted.test'}).status_code==403
        assert client.post('/api/v7/feedback',content='x'*17000,headers={'Content-Type':'application/json'}).status_code==413
        db.set_setting('registration_open','0')
        import v7_operations
        controls=v7_operations.controls()
        v7_operations.update({**controls,'maintenance':True},'测试维护反馈',1)
        assert client.post('/api/v7/feedback',json=payload()).status_code==200


def test_update_audit_failure_rolls_back(monkeypatch):
    t=feedback.submit('user:1',feedback.FeedbackIn(**payload()),'local')['feedback']
    def fail(*args):raise RuntimeError('audit storage failure')
    monkeypatch.setattr(feedback,'audit',fail)
    with pytest.raises(RuntimeError):feedback.update(t['id'],feedback.UpdateIn(revision=1,status='reviewing',reply='正在处理'),1)
    result=feedback.list_own('user:1')['items'][0]
    assert result['status']=='new' and result['revision']==1 and result['replies']==[]


def test_inbox_pagination_and_no_personal_data_in_public_endpoints(monkeypatch):
    now=int(time.time())
    for i in range(27):
        monkeypatch.setattr(feedback.time,'time',lambda:now+i*86401)
        feedback.submit('user:1',feedback.FeedbackIn(**payload(contact_email='private@example.test')),'local')
    assert len(feedback.list_own('user:1')['items'])==10
    assert len(feedback.list_own('user:1',3)['items'])==7
    assert feedback.list_own('user:1',999)['page']==3
    assert feedback.admin_list(page=2)['total']==27 and len(feedback.admin_list(page=2)['items'])==2
    public=json.dumps(feedback.list_own('user:1'))
    assert 'private@example.test' not in public
