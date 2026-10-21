"""Referral qualification and reward provenance against disposable databases."""
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
import v7_referrals as referrals


def user(number, admin=False):
    phone = f"139{number:08d}"
    assert db.create_user(phone, f"user{number}", "test-password")[0]
    result = db.authenticate(phone, "test-password")
    if admin:
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?", (result["id"],))
    return result["id"], phone


def guest(number):
    return db.get_or_create_guest(f"referral-guest-{number}")["id"]


def referred(number, guest_id):
    phone = f"138{number:08d}"
    assert db.create_user(phone, f"new{number}", "test-password", on_created=lambda c, uid: referrals.register_created(c, uid, guest_id))[0]
    return db.authenticate(phone,"test-password")["id"]


def record_for(uid):
    with db.conn() as c:
        return dict(c.execute("SELECT * FROM v7_referrals WHERE invitee_id=?", (uid,)).fetchone())


def test_first_attribution_and_original_campaign_survive_configuration_changes():
    first,_ = user(1)
    second,_ = user(2)
    admin,_ = user(3,True)
    gid = guest(1)
    original = referrals.attribute(gid, referrals.ensure_code(first))
    assert original["attributed"] and original["campaign"]["pro_days"] == 30
    updated = referrals.update_campaign(referrals.CampaignInput(pro_days=7,skin_days=14),admin,"调整新活动")
    assert updated["version"] == 2
    assert referrals.attribute(gid,referrals.ensure_code(second))["campaign"]["version"] == 1
    invitee = referred(1,gid)
    record = record_for(invitee)
    assert record["inviter_id"] == first and record["status"] == "rewarded"
    grants = commerce.entitlement_details(f"user:{first}")
    assert set(grants["features"]) == {"pro","cosmic"}
    assert {row["source_kind"] for row in grants["sources"]} == {"referral"}
    assert not engine.features(f"user:{second}") and not engine.features(f"user:{invitee}")
    with db.conn() as c:
        assert {r[0] for r in c.execute("SELECT days FROM v7_reward_grants")} == {30}
    info=referrals.mine(first)
    assert info["completed_this_month"] == 1
    assert info["records"][0]["invitee_label"] == "n***"
    assert "invitee_id" not in info["records"][0]


def test_campaign_publish_rejects_stale_snapshot_without_new_version_or_audit():
    actor, _ = user(120, True)
    current = referrals.current_campaign()
    published = referrals.update_campaign(referrals.CampaignInput(pro_days=7), actor, '更新奖励天数', expected_version=current['version'])
    assert published['version'] == current['version'] + 1
    with pytest.raises(engine.DomainError, match='已更新') as error:
        referrals.update_campaign(referrals.CampaignInput(pro_days=90), actor, '旧页面的修改', expected_version=current['version'])
    assert error.value.status == 409
    assert referrals.current_campaign() == published
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='referral_campaign'").fetchone()[0] == 1


def test_concurrent_campaign_publish_accepts_only_one_editor_at_the_same_version():
    actor, _ = user(121, True)
    version = referrals.current_campaign()['version']
    def publish(days):
        try:
            return referrals.update_campaign(referrals.CampaignInput(pro_days=days), actor, '并发发布验收', expected_version=version)
        except engine.DomainError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(publish, (7, 14)))
    assert sum(isinstance(result, dict) for result in outcomes) == 1
    assert outcomes.count(409) == 1
    assert referrals.current_campaign()['version'] == version + 1


def test_campaign_http_version_guard_preserves_existing_attribution_and_rewards():
    owner, _ = user(122)
    actor, phone = user(123, True)
    gid = guest(122)
    referrals.attribute(gid, referrals.ensure_code(owner))
    with TestClient(server.app) as client:
        assert client.post('/api/login', json={'phone': phone, 'password': 'test-password'}).status_code == 200
        current = client.get('/api/v7/admin/referrals/settings').json()['campaign']
        fields = {key: value for key, value in current.items() if key not in {'id', 'version'}}
        payload = {**fields, 'pro_days': 7, 'reason': '新版奖励测试', 'expected_version': current['version']}
        assert client.put('/api/v7/admin/referrals/settings', json=payload).status_code == 200
        assert client.put('/api/v7/admin/referrals/settings', json=payload).status_code == 409
        assert client.put('/api/v7/admin/referrals/settings', json={**payload, 'expected_version': True}).status_code == 422
        assert client.put('/api/v7/admin/referrals/settings', json={**payload, 'expected_version': 0}).status_code == 422
    invitee = referred(122, gid)
    assert record_for(invitee)['campaign_id'] == current['id']
    with db.conn() as c:
        assert {row[0] for row in c.execute('SELECT days FROM v7_reward_grants')} == {30}
        snapshot = json.loads(c.execute('SELECT payload FROM v7_campaigns ORDER BY version DESC LIMIT 1').fetchone()[0])
        assert 'expected_version' not in snapshot


def test_concurrent_qualification_obeys_cap_and_never_duplicates_or_resets_after_revoke():
    owner,_ = user(10)
    admin,_ = user(11,True)
    code=referrals.ensure_code(owner)
    for n in range(4):
        referrals.attribute(guest(10+n),code)
    with ThreadPoolExecutor(max_workers=4) as pool:
        invitees=list(pool.map(lambda n:referred(10+n,guest(10+n)),range(4)))
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(referrals.qualify_user,invitees*4))
    records=[record_for(uid) for uid in invitees]
    assert sorted(r["status"] for r in records)==["capped","rewarded","rewarded","rewarded"]
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v7_reward_grants").fetchone()[0]==6
        assert c.execute("SELECT COUNT(*) FROM v6_entitlements").fetchone()[0]==6
    rewarded=next(r for r in records if r["status"]=="rewarded")
    referrals.review(rewarded["id"],"revoke","核验后撤销",admin)
    with pytest.raises(engine.DomainError,match="不能再次"):
        referrals.review(rewarded["id"],"retry","再次尝试",admin)
    new_gid=guest(99)
    referrals.attribute(new_gid,code)
    extra=referred(99,new_gid)
    assert record_for(extra)["status"]=="capped"


def test_registration_and_both_grants_roll_back_as_one_transaction(monkeypatch):
    owner,_=user(20)
    gid=guest(20)
    referrals.attribute(gid,referrals.ensure_code(owner))
    real_grant=referrals._grant
    def fail_skin(c,rid,uid,feature,days,now):
        if feature=="cosmic":
            raise RuntimeError("controlled grant failure")
        real_grant(c,rid,uid,feature,days,now)
    monkeypatch.setattr(referrals,"_grant",fail_skin)
    with pytest.raises(RuntimeError,match="controlled"):
        referred(20,gid)
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM users WHERE phone='13800000020'").fetchone()[0]==0
        assert c.execute("SELECT COUNT(*) FROM v7_referrals").fetchone()[0]==0
        assert c.execute("SELECT COUNT(*) FROM v7_reward_grants").fetchone()[0]==0
        assert c.execute("SELECT COUNT(*) FROM v6_entitlements").fetchone()[0]==0
        assert c.execute("SELECT registered_user_id FROM v7_guest_referrals").fetchone()[0] is None
    monkeypatch.setattr(referrals,"_grant",real_grant)
    assert record_for(referred(20,gid))["status"]=="rewarded"


def test_refund_or_reward_revoke_keeps_other_sources_and_extensions():
    owner,_=user(30)
    admin,_=user(31,True)
    owner_key=f"user:{owner}"
    code=commerce.generate_cards("pro",90,1,"付费来源模拟","验收",None,admin,payments.CATALOG)["codes"][0]
    first=commerce.redeem_card(code,owner)["expires_at"]
    gid=guest(30)
    referrals.attribute(gid,referrals.ensure_code(owner))
    invitee=referred(30,gid)
    second_code=commerce.generate_cards("pro",30,1,"后续权益","验收",None,admin,payments.CATALOG)["codes"][0]
    end=commerce.redeem_card(second_code,owner)["expires_at"]
    assert end==first+60*86400
    referral=record_for(invitee)
    referrals.review(referral["id"],"revoke","仅撤销邀请来源",admin)
    details=commerce.entitlement_details(owner_key)
    assert details["features"]["pro"]["expires_at"]==first+30*86400
    assert "cosmic" not in details["features"]
    assert all(row["active"] for row in details["sources"] if row["source_kind"]=="card")


def test_experience_gate_requires_post_registration_real_draw_and_retries(cfg):
    owner,_=user(40)
    admin,_=user(41,True)
    referrals.update_campaign(referrals.CampaignInput(require_experience=True,reward_newcomer=True),admin,"开启体验条件")
    gid=guest(40)
    referrals.attribute(gid,referrals.ensure_code(owner))
    # A pre-registration guest draw is not sufficient even if login transfers it.
    old_run=engine.new_run(f"guest:{gid}",cfg)
    engine.draw(f"guest:{gid}",old_run["id"],"before-registration",old_run["control_token"])
    invitee=referred(40,gid)
    with db.conn() as c:
        c.execute("UPDATE v6_runs SET owner=? WHERE id=?",(f"user:{invitee}",old_run["id"]))
    referrals.qualify_user(invitee)
    assert record_for(invitee)["status"]=="pending"
    rehearsal=engine.new_run(f"user:{invitee}",cfg,True)
    engine.draw(f"user:{invitee}",rehearsal["id"],"rehearsal-only",rehearsal["control_token"])
    referrals.qualify_user(invitee)
    assert record_for(invitee)["status"]=="pending"
    actual=engine.new_run(f"user:{invitee}",cfg)
    engine.draw(f"user:{invitee}",actual["id"],"post-registration",actual["control_token"])
    referrals.qualify_user(invitee)
    assert record_for(invitee)["status"]=="rewarded"
    assert engine.features(f"user:{invitee}")=={"pro","cosmic"}
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v7_reward_grants").fetchone()[0]==4


def test_disabled_and_expired_campaigns_and_consumed_browser_attribution(monkeypatch):
    owner,_=user(50)
    admin,_=user(51,True)
    code=referrals.ensure_code(owner)
    gid=guest(50)
    referrals.attribute(gid,code)
    referrals.update_campaign(referrals.CampaignInput(enabled=False),admin,"暂停新活动")
    assert not referrals.attribute(guest(51),code)["attributed"]
    # The earlier valid promise remains intact after closing new invitations.
    one=referred(50,gid)
    assert record_for(one)["status"]=="rewarded"
    assert not referrals.attribute(gid,code)["attributed"]
    two=referred(51,gid)
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v7_referrals WHERE invitee_id=?",(two,)).fetchone()[0]==0
    referrals.update_campaign(referrals.CampaignInput(),admin,"重新开放")
    expired=guest(52)
    referrals.attribute(expired,code)
    with db.conn() as c:
        c.execute("UPDATE v7_guest_referrals SET expires_at=? WHERE guest_id=?",(int(time.time())-1,expired))
    late=referred(52,expired)
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v7_referrals WHERE invitee_id=?",(late,)).fetchone()[0]==0


def test_http_registration_real_reward_privacy_permissions_and_no_old_account_rebind(email_registration):
    owner,phone=user(60)
    admin_id,admin_phone=user(61,True)
    with TestClient(server.app) as host, TestClient(server.app) as friend, TestClient(server.app) as admin:
        assert host.post('/api/login',json={'phone':phone,'password':'test-password'}).status_code==200
        invitation=host.get('/api/v7/referrals/me').json()
        assert friend.get('/api/v7/referrals/me').status_code==401
        assert host.get('/api/v7/admin/referrals/settings').status_code==403
        assert friend.post('/api/v7/referrals/visit',json={'code':invitation['code']}).json()['attributed']
        payload=email_registration(friend,'friend60@example.test','friend60')
        assert friend.post('/api/register',json=payload).status_code==200
        assert host.get('/api/v6/account').json()['features'].keys()=={'pro','cosmic'}
        assert friend.post('/api/login',json={'identifier':payload['email'],'password':payload['password']}).status_code==200
        assert friend.post('/api/v7/referrals/visit',json={'code':invitation['code']}).json()['attributed'] is False
        records=host.get('/api/v7/referrals/me').json()['records']
        assert records[0]['invitee_label']=='f***'
        assert payload['email'] not in str(records)
        assert admin.post('/api/login',json={'phone':admin_phone,'password':'test-password'}).status_code==200
        current=admin.get('/api/v7/admin/referrals/settings').json()
        assert current['skins'][0]['feature']=='cosmic'
        fields={key:value for key,value in current['campaign'].items() if key not in {'id','version'}}
        fields.update(reason='后台调整皮肤赠送',skin_feature='',pro_days=7)
        assert admin.put('/api/v7/admin/referrals/settings',json=fields).status_code==200
        assert admin.get('/api/v7/admin/referrals').json()['total']==1
        assert admin.get('/api/v7/admin/overview').json()['referrals']['rewarded']==1
        assert admin.put('/api/v7/admin/referrals/settings',json={**fields,'skin_feature':'undeveloped-skin'}).status_code==400


def test_manual_hold_survives_draw_retry_and_account_refresh_until_release(cfg):
    owner, _ = user(70)
    actor, _ = user(71, True)
    referrals.update_campaign(referrals.CampaignInput(require_experience=True), actor, '需要真实体验')
    gid = guest(70)
    referrals.attribute(gid, referrals.ensure_code(owner))
    newcomer = referred(70, gid)
    rid = record_for(newcomer)['id']
    held = referrals.review(rid, 'hold', '内部核验记录，不应公开', actor)
    assert held['manual_hold'] and held['status'] == 'held'
    referrals.review(rid, 'hold', '内部核验记录，不应公开', actor)
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='referral_hold'").fetchone()[0] == 1
    run = engine.new_run(f'user:{newcomer}', cfg)
    engine.draw(f'user:{newcomer}', run['id'], 'draw-while-held', run['control_token'])
    referrals.qualify_user(newcomer)
    referrals.retry_pending()
    public = referrals.mine(owner)['records'][0]
    assert public['status'] == 'held' and public['reason'] == '奖励资格核验中'
    assert 'review_note' not in public and '内部核验' not in str(public)
    assert not engine.features(f'user:{owner}')
    with pytest.raises(engine.DomainError, match='请先解除'):
        referrals.review(rid, 'retry', '尝试提前发放', actor)
    released = referrals.review(rid, 'release', '核验通过，恢复资格评估', actor)
    assert not released['manual_hold'] and released['status'] == 'rewarded'
    assert engine.features(f'user:{owner}') == {'pro', 'cosmic'}
    referrals.review(rid, 'release', '重复放行无副作用', actor)
    with db.conn() as c:
        assert c.execute('SELECT COUNT(*) FROM v7_reward_grants').fetchone()[0] == 2
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='referral_release'").fetchone()[0] == 1


def test_release_does_not_bypass_experience_account_status_or_monthly_cap(cfg):
    owner, _ = user(80)
    actor, _ = user(81, True)
    referrals.update_campaign(referrals.CampaignInput(require_experience=True, monthly_cap=1), actor, '设置验收条件')
    code = referrals.ensure_code(owner)
    invitees = []
    for n in (80, 81):
        gid = guest(n)
        referrals.attribute(gid, code)
        invitees.append(referred(n, gid))
    first, second = invitees
    rid = record_for(first)['id']
    referrals.review(rid, 'hold', '等待人工核验', actor)
    assert referrals.review(rid, 'release', '允许重新评估', actor)['status'] == 'pending'
    for uid in invitees:
        run = engine.new_run(f'user:{uid}', cfg)
        engine.draw(f'user:{uid}', run['id'], f'actual-{uid}', run['control_token'])
    with db.conn() as c:
        c.execute("UPDATE users SET status='disabled' WHERE id=?", (first,))
    referrals.review(rid, 'hold', '停用账号核验', actor)
    assert referrals.review(rid, 'release', '解除人工标记', actor)['status'] == 'held'
    assert not engine.features(f'user:{owner}')
    referrals.qualify_user(second)
    assert record_for(second)['status'] == 'rewarded'
    with db.conn() as c:
        c.execute("UPDATE users SET status='active' WHERE id=?", (first,))
    referrals.review(rid, 'hold', '恢复账号核验', actor)
    assert referrals.review(rid, 'release', '恢复资格检查', actor)['status'] == 'capped'
    with db.conn() as c:
        assert c.execute('SELECT COUNT(*) FROM v7_reward_grants').fetchone()[0] == 2


def test_flagging_rewarded_invite_keeps_rights_and_revoke_hides_private_reason():
    owner, _ = user(90)
    actor, _ = user(91, True)
    gid = guest(90)
    referrals.attribute(gid, referrals.ensure_code(owner))
    newcomer = referred(90, gid)
    rid = record_for(newcomer)['id']
    before = commerce.entitlement_details(f'user:{owner}')
    marked = referrals.review(rid, 'hold', '内部事后复核', actor)
    assert marked['status'] == 'rewarded' and marked['manual_hold']
    assert commerce.entitlement_details(f'user:{owner}') == before
    assert referrals.list_records(needs_review=True)['total'] == 1
    referrals.review(rid, 'revoke', '不向好友公开的审查内容', actor)
    assert referrals.list_records(needs_review=True)['total'] == 0
    assert not engine.features(f'user:{owner}')
    public = referrals.mine(owner)['records'][0]
    assert public['reason'] == '该邀请奖励已撤销'
    assert '审查内容' not in str(public)
    for action in ('hold', 'release', 'retry'):
        with pytest.raises(engine.DomainError):
            referrals.review(rid, action, '不能恢复已撤销来源', actor)


def test_user_referral_detail_filters_both_roles_and_requires_admin():
    owner, _ = user(100)
    actor, phone = user(101, True)
    outsider, outsider_phone = user(102)
    gid = guest(100)
    referrals.attribute(gid, referrals.ensure_code(owner))
    middle = referred(100, gid)
    gid2 = guest(101)
    referrals.attribute(gid2, referrals.ensure_code(middle))
    referred(101, gid2)
    rid = record_for(middle)['id']
    with TestClient(server.app) as client:
        path = f'/api/v7/admin/users/{middle}/referrals'
        assert client.get(path).status_code == 401
        assert client.post('/api/login', json={'phone': outsider_phone, 'password': 'test-password'}).status_code == 200
        assert client.get(path).status_code == 403
        assert client.post(f'/api/v7/admin/referrals/{rid}/review', json={'action': 'hold', 'reason': '不能越权'}).status_code == 403
        assert client.post('/api/login', json={'phone': phone, 'password': 'test-password'}).status_code == 200
        first = client.get(path, params={'page_size': 1}).json()
        second = client.get(path, params={'page_size': 1, 'page': 2}).json()
        assert first['total'] == 2 and first['pages'] == 2
        assert first['records'][0]['relationship'] == 'inviter'
        assert second['records'][0]['relationship'] == 'invitee'
        assert first['records'][0]['id'] != second['records'][0]['id']
        assert client.get(f'/api/v7/admin/users/{outsider}/referrals').json()['total'] == 0
        assert client.get('/api/v7/admin/users/99999/referrals').status_code == 404
        assert client.get(path, params={'page_size': 101}).status_code == 400
        marked = client.post(f'/api/v7/admin/referrals/{rid}/review', json={'action': 'hold', 'reason': '  需要核验  '})
        assert marked.status_code == 200 and marked.json()['record']['review_note'] == '需要核验'
        assert marked.json()['record']['review_actor_id'] == actor
        assert client.get('/api/v7/admin/referrals?needs_review=true').json()['total'] == 1
        assert client.get('/api/v7/admin/overview').json()['referrals']['needs_review'] == 1
        assert client.post(f'/api/v7/admin/referrals/{rid}/review', json={'action': 'release', 'reason': '   '}).status_code == 422


def test_review_columns_migrate_old_referral_rows_without_changing_rewards():
    owner, _ = user(110)
    gid = guest(110)
    referrals.attribute(gid, referrals.ensure_code(owner))
    newcomer = referred(110, gid)
    before = record_for(newcomer)
    extra = {'manual_hold', 'review_note', 'reviewed_at', 'review_actor_id'}
    with db.conn() as c:
        for column in extra:
            c.execute(f'ALTER TABLE v7_referrals DROP COLUMN {column}')
        grants = [dict(row) for row in c.execute('SELECT * FROM v7_reward_grants')]
    referrals.init_schema()
    referrals.init_schema()
    after = record_for(newcomer)
    assert {key: value for key, value in after.items() if key not in extra} == {key: value for key, value in before.items() if key not in extra}
    assert after['manual_hold'] == 0 and after['review_note'] == ''
    assert after['reviewed_at'] is None and after['review_actor_id'] is None
    with db.conn() as c:
        assert [dict(row) for row in c.execute('SELECT * FROM v7_reward_grants')] == grants
