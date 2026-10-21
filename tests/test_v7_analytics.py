"""Conversion counts must describe an ordered, de-duplicated cohort."""
import json
from datetime import datetime

from fastapi.testclient import TestClient

import db
import server
import v6_engine as engine
import v7_analytics as analytics
import v7_referrals as referrals

NOW = 1790568000


def account(number, signup, role='user', status='active'):
    assert db.create_user(f'137{number:08d}', f'metricUser{number}', 'test-password')[0]
    with db.conn() as c:
        uid = c.execute('SELECT id FROM users WHERE custom_id=?',(f'metricUser{number}',)).fetchone()[0]
        c.execute('UPDATE users SET created_at=?,role=?,status=? WHERE id=?',
                  (datetime.fromtimestamp(signup).isoformat(timespec='seconds'),role,status,uid))
    return f'user:{uid}'


def draw(owner, stamp, rehearsal=False):
    cfg = engine.DrawConfig(app='food',machine='capsule',items=[engine.Candidate(id='one',name='测试候选')])
    run = engine.new_run(owner,cfg,rehearsal)
    result = engine.draw(owner,run['id'],'metrics-draw',run['control_token'])
    with db.conn() as c:
        c.execute('UPDATE v6_draws SET created_at=? WHERE id=?',(stamp,result['id']))


def preview(owner, stamp, day='2026-09-28'):
    with db.conn() as c:
        c.execute('INSERT INTO v7_metrics(day,subject,event,first_at) VALUES(?,?,?,?)',(day,owner,'skin_preview',stamp))


def payment(owner, stamp, order_no, provider='alipay', state='paid'):
    with db.conn() as c:
        c.execute('''INSERT INTO v6_orders(order_no,owner,request_id,snapshot,amount,state,created_at,paid_at)
            VALUES(?,?,?,?,?,?,?,?)''',(order_no,owner,order_no,json.dumps({'provider':provider,'feature':'pro'}),9900,state,stamp-100,stamp))


def test_cohort_merges_handoffs_and_requires_each_step_in_order():
    converted = account(1,NOW-800)
    reversed_order = account(2,NOW-800)
    no_preview = account(3,NOW-800)
    existing = account(4,NOW-86400*60)
    admin = account(5,NOW-800,'superadmin')
    for owner in (converted,reversed_order,no_preview,existing,admin):
        draw(owner,NOW-1000)
    draw('guest:unregistered',NOW-1000)
    draw('guest:rehearsal',NOW-1000,True)
    draw('guest:outside',NOW-86400*40)
    draw('guest:future',NOW+1)
    draw('guest:second-browser',NOW-950)
    with db.conn() as c:
        c.execute('INSERT INTO v6_guest_handoffs VALUES(?,?,?)',('guest:second-browser',converted,NOW-800))
    # Migrated guest previews and signed-in activity map to the same account.
    preview('guest:second-browser',NOW-700)
    preview(converted,NOW-600)
    preview(reversed_order,NOW-700)
    preview(no_preview,None)  # legacy date-only rows cannot invent event order
    payment(converted,NOW-500,'converted')
    payment(reversed_order,NOW-900,'paid-too-early')
    payment(no_preview,NOW-500,'missing-preview')
    result = analytics.usage(NOW)
    assert result['active_accounts'] == 4 and result['guest_scopes'] == 1
    assert result['cohort'] == {
        'experienced':4,'registered':3,'previewed':2,'paid':1,
        'registration_rate':75.0,'preview_rate':66.7,'payment_rate':50.0,
    }
    assert '测试候选' not in str(result) and converted not in str(result)


def test_empty_cohort_uses_unavailable_rates_not_zero_conversion():
    assert analytics.usage(NOW)['cohort'] == {
        'experienced':0,'registered':0,'previewed':0,'paid':0,
        'registration_rate':None,'preview_rate':None,'payment_rate':None,
    }


def test_sources_separate_verified_payments_gifts_and_unknown_history():
    member = account(11,NOW-800)
    disabled = account(12,NOW-800,status='disabled')
    admin = account(13,NOW-800,role='superadmin')
    payment(member,NOW-500,'paid-source')
    payment(member,NOW-500,'historical-provider',provider='unverified')
    rows = [
        (member,'pro',NOW+500,'paid-source'),
        (member,'pro',NOW+500,'card:one'),
        (member,'cosmic',NOW+500,'invite:one'),
        (member,'cosmic',NOW+500,'invite:two'),
        (member,'pro',NOW+500,'admin:one'),
        (member,'pro',NOW+500,'historical-provider'),
        (member,'pro',NOW-1,'card:expired'),
        (member,'pro',NOW+500,'invite:revoked'),
        (disabled,'pro',None,'card:disabled'),
        (admin,'pro',None,'card:admin'),
    ]
    with db.conn() as c:
        c.executemany('INSERT INTO v6_entitlements VALUES(?,?,?,?)',rows)
        c.execute('INSERT INTO v6_entitlement_revocations VALUES(?,?,?,?,?)',('invite:revoked',member,'pro','撤销测试',NOW))
    result = analytics.entitlement_sources(NOW)
    assert result['total_accounts'] == 1 and result['feature_totals'] == {'pro':1,'cosmic':1}
    assert result['accounts'] == {'paid':1,'card':1,'referral':1,'manual':1,'legacy':0,'other':1}
    assert result['features']['cosmic']['referral'] == 1
    assert result['features']['pro']['referral'] == 0
    assert member not in str(result)


def test_date_only_metric_migration_preserves_rows_and_real_repeat_sets_time_once(monkeypatch):
    with db.conn() as c:
        c.execute('DROP TABLE v7_metrics')
        c.execute('CREATE TABLE v7_metrics(day TEXT,subject TEXT,event TEXT,PRIMARY KEY(day,subject,event))')
        c.execute("INSERT INTO v7_metrics VALUES('2026-01-01','guest:old','skin_preview')")
    referrals.init_schema()
    referrals.init_schema()
    with db.conn() as c:
        old = c.execute("SELECT * FROM v7_metrics WHERE subject='guest:old'").fetchone()
        assert old['day'] == '2026-01-01' and old['first_at'] is None
    with TestClient(server.app) as client:
        for stamp in (NOW,NOW+1):
            monkeypatch.setattr('v7_api.time.time',lambda:stamp)
            assert client.post('/api/v7/events',json={'event':'skin_preview'}).status_code == 200
    with db.conn() as c:
        rows = c.execute("SELECT first_at FROM v7_metrics WHERE subject<>'guest:old'").fetchall()
        assert len(rows) == 1 and rows[0][0] == NOW
