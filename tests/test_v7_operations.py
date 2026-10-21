"""Operational writes, backup integrity and sale/maintenance gates in isolated databases."""
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from contextlib import closing

import pytest
from fastapi.testclient import TestClient
import db
import server
import v6_engine as engine
import v6_payments as payments
import v7_operations as ops
from test_payments import merchant


@pytest.fixture
def administrator(tmp_path,monkeypatch):
    monkeypatch.setenv('LOTTERY_BACKUP_DIR',str(tmp_path/'private-backups'))
    assert db.create_user('13988888001','opsAdmin','test-password')[0]
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE phone='13988888001'")
    with TestClient(server.app) as client:
        assert client.post('/api/login',json={'phone':'13988888001','password':'test-password'}).status_code==200
        yield client


def update(client,**changes):
    before=client.get('/api/v7/admin/system').json()['operations']['controls']
    response=client.put('/api/v7/admin/operations',json={**before,**changes,'reason':'隔离环境验收'})
    assert response.status_code==200,response.text
    return response.json()['controls']


def test_version_conflict_and_strict_validation_preserve_current_controls(administrator):
    client=administrator;before=ops.controls()
    after=update(client,sales_open=False)
    assert after['version']==before['version']+1
    assert client.put('/api/v7/admin/operations',json={**before,'maintenance':True,'reason':'过期页面'}).status_code==409
    for patch in ({'sales_open':'yes'},{'maintenance':1},{'maintenance_message':' '},{'version':True},{'directory':'/public'}):
        assert client.put('/api/v7/admin/operations',json={**after,**patch,'reason':'非法输入'}).status_code==422
    assert ops.controls()==after
    with db.conn() as c:
        events=c.execute("SELECT detail FROM admin_audit WHERE action='operations_update'").fetchall()
    assert len(events)==1 and json.loads(events[0][0])['before']==before


def test_maintenance_stops_new_work_but_preserves_login_existing_runs_and_settings(administrator,cfg):
    client=administrator
    run=client.post('/api/v6/runs',json={'config':cfg.model_dump()}).json()
    assert 'id' in run
    update(client,maintenance=True,maintenance_message='计划维护，请稍后创建新场次。')
    assert client.post('/api/register',json={'phone':'13988888002','custom_id':'newuser','password':'test-password'}).status_code==503
    assert client.post('/api/v6/runs',json={'config':cfg.model_dump()}).status_code==503
    assert client.get('/api/v6/runs/'+run['id']).status_code==200
    uid=db.authenticate('13988888001','test-password')['id']
    assert engine.draw(f'user:{uid}',run['id'],'existing-draw-request',run['control_token'])['results']
    public=client.get('/api/v7/public').json()
    assert public['registration_open'] is False and public['maintenance']['enabled']
    assert client.post('/api/login',json={'phone':'13988888001','password':'test-password'}).status_code==200
    update(client,maintenance=False)
    assert client.get('/api/v7/public').json()['registration_open'] is True
    assert client.post('/api/v6/runs',json={'config':cfg.model_dump()}).status_code==200


def test_registration_transaction_rechecks_maintenance_after_email_code(administrator,monkeypatch,email_registration):
    original=db.create_user
    def racing(*args,**kwargs):
        values=ops.controls();ops.update({**values,'maintenance':True},'在注册事务前进入维护',1)
        return original(*args,**kwargs)
    monkeypatch.setattr(db,'create_user',racing)
    payload=email_registration(administrator,'race@example.test','raceNew')
    response=administrator.post('/api/register',json=payload)
    assert response.status_code==503
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM users WHERE email='race@example.test'").fetchone()[0]==0


def test_sales_toggle_cannot_bypass_server_gate_or_payment_configuration(administrator,monkeypatch):
    update(administrator,sales_open=True)
    monkeypatch.setattr(payments,'configured',lambda:True)
    assert not payments.enabled()
    monkeypatch.setenv('V6_SALES_ENABLED','1');assert payments.enabled()
    update(administrator,sales_open=False);assert not payments.enabled()
    update(administrator,sales_open=True,maintenance=True);assert not payments.enabled()
    update(administrator,maintenance=False);monkeypatch.setattr(payments,'configured',lambda:False)
    assert not payments.enabled()


def test_sales_pause_retains_order_retry_and_queries(administrator,merchant):
    uid=db.authenticate('13988888001','test-password')['id'];owner=f'user:{uid}'
    order=payments.checkout(owner,'cosmic','original-order-12345')
    update(administrator,sales_open=False)
    assert payments.checkout(owner,'cosmic','original-order-12345')['order_no']==order['order_no']
    assert payments.order(owner,order['order_no'])['state']=='pending'
    with pytest.raises(engine.DomainError):payments.checkout(owner,'pro','new-order-12345678')


def test_backup_is_private_integral_idempotent_and_keeps_original_rows(administrator,tmp_path):
    body={'kind':'backup','request_id':'same-backup-request-001','reason':'保存验收库快照'}
    response=administrator.post('/api/v7/admin/operations/tasks',json=body)
    assert response.status_code==200,response.text
    job=response.json()['job'];assert job['state']=='succeeded'
    assert 'path' not in job['result'] and str(tmp_path) not in response.text
    saved=tmp_path/'private-backups'/job['result']['name'];assert saved.is_file()
    assert hashlib.sha256(saved.read_bytes()).hexdigest()==job['result']['sha256']
    with closing(sqlite3.connect(saved)) as c:
        assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert c.execute("SELECT custom_id FROM users WHERE phone='13988888001'").fetchone()[0]=='opsAdmin'
    again=administrator.post('/api/v7/admin/operations/tasks',json=body).json()['job']
    assert again['id']==job['id'] and len(list(saved.parent.glob('*.sqlite')))==1
    assert administrator.post('/api/v7/admin/operations/tasks',json={**body,'reason':'更换操作原因'}).status_code==409
    # Backup data is never exposed through the static site.
    assert administrator.get('/'+saved.name).status_code==404
    saved.rename(saved.with_suffix('.kept'))
    checked=administrator.get('/api/v7/admin/operations/tasks/'+job['id']).json()['job']
    assert checked['result']['file_status']=='missing_or_changed'


def test_failed_backup_records_failure_without_exposing_internal_paths(administrator,monkeypatch):
    monkeypatch.setenv('LOTTERY_BACKUP_DIR',str(Path(server.STATIC_DIR)/'should-not-exist'))
    response=administrator.post('/api/v7/admin/operations/tasks',json={'kind':'backup','request_id':'bad-backup-request-001','reason':'拒绝公开目录'})
    assert response.status_code==200
    assert response.json()['job']['state']=='failed'
    assert server.STATIC_DIR not in response.text
    assert not (Path(server.STATIC_DIR)/'should-not-exist').exists()


def test_concurrent_duplicate_task_executes_once_and_can_be_queried(monkeypatch):
    entered=Event();release=Event();calls=[]
    def work(job_id):
        calls.append(job_id);entered.set();assert release.wait(10);return {'ok':True}
    monkeypatch.setattr(ops,'_backup',work)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first=pool.submit(ops.run_task,'backup',1,'concurrent-request-001','同一请求')
        assert entered.wait(5)
        duplicate=pool.submit(ops.run_task,'backup',1,'concurrent-request-001','同一请求').result(timeout=5)
        assert duplicate['state']=='running'
        release.set();completed=first.result(timeout=5)
    assert len(calls)==1 and completed['id']==duplicate['id']
    assert ops.job(completed['id'])['state']=='succeeded'


def test_task_startup_recovery_is_recorded_and_does_not_claim_a_backup(administrator):
    system=administrator.get('/api/v7/admin/system').json()['operations']
    assert system['latest_backup'] is None
    recovery=system['jobs'][0]
    assert recovery['kind']=='referral_retry' and recovery['state']=='succeeded'
    assert recovery['result']['checked']==0


def test_operations_and_tasks_require_independent_superadmin_authorization():
    assert db.create_user('13988888004','ordinaryOps','test-password')[0]
    with TestClient(server.app) as client:
        for login in [False,True]:
            if login:client.post('/api/login',json={'phone':'13988888004','password':'test-password'})
            expected=403 if login else 401
            assert client.get('/api/v7/admin/system').status_code==expected
            assert client.put('/api/v7/admin/operations',json={**ops.controls(),'reason':'不能越权'}).status_code==expected
            assert client.post('/api/v7/admin/operations/tasks',json={'kind':'backup','request_id':'unauthorized-123456','reason':'不能越权'}).status_code==expected
            assert client.get('/api/v7/admin/operations/tasks/not-a-task').status_code==expected
