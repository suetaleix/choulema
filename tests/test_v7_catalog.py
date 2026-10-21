import pytest
from fastapi.testclient import TestClient

import db
import server
import v6_commerce as commerce
import v6_payments as payments
import v7_referrals as referrals


@pytest.fixture
def admin():
    assert db.create_user('13500000001','catalogAdmin','test-password')[0]
    uid=db.authenticate('13500000001','test-password')['id']
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE id=?",(uid,))
    with TestClient(server.app) as client:
        client.post('/api/login',json={'phone':'13500000001','password':'test-password'})
        yield uid,client


def test_catalog_changes_are_versioned_shared_and_dont_change_price_or_entitlements(admin):
    _,client=admin
    before=client.get('/api/v6/admin/products').json()['products']
    change={'sort_order':20,'giftable':False,'metadata_version':1,'reason':'调整新品展示顺序'}
    response=client.put('/api/v7/admin/products/cosmic/metadata',json=change)
    assert response.status_code==200 and response.json()['metadata']['metadata_version']==2
    assert client.put('/api/v7/admin/products/cosmic/metadata',json=change).status_code==409
    with TestClient(server.app) as guest:
        products=guest.get('/api/v6/shop').json()['products']
    assert [p['slug'] for p in products]==['pro','cosmic']
    cosmic=next(p for p in products if p['slug']=='cosmic')
    old=next(p for p in before if p['slug']=='cosmic')
    assert cosmic['giftable'] is False
    for key in ('price_cents','price_version','feature','kind','machines','days'):
        assert cosmic[key]==old[key]
    assert cosmic['sale_enabled'] is False
    assert referrals.skins()==[]
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='product_metadata'").fetchone()[0]==1


def test_giftability_applies_to_new_rules_but_keeps_existing_promises_and_cards(admin):
    actor,client=admin
    assert db.create_user('13500000002','inviter','test-password')[0]
    uid=db.authenticate('13500000002','test-password')['id']
    gid=db.get_or_create_guest('catalog-invite-guest')['id']
    assert referrals.attribute(gid,referrals.ensure_code(uid))['attributed']
    change={'sort_order':0,'giftable':False,'metadata_version':1,'reason':'不再用于新活动'}
    assert client.put('/api/v7/admin/products/cosmic/metadata',json=change).status_code==200
    # Publishing enabled rules rejects unavailable gifts; existing promises remain valid.
    with pytest.raises(Exception,match='允许新邀请规则'):
        referrals.update_campaign(referrals.CampaignInput(),actor,'新的活动规则')
    assert db.create_user('13500000003','invitee','test-password',on_created=lambda c,new:referrals.register_created(c,new,gid))[0]
    assert 'cosmic' in commerce.entitlement_details(f'user:{uid}')['features']
    disabled=referrals.update_campaign(referrals.CampaignInput(enabled=False),actor,'停止当前活动')
    assert disabled['enabled'] is False
    assert commerce.generate_cards('cosmic',30,1,'独立皮肤卡','不受活动赠送设置影响',None,actor,payments.CATALOG)['quantity']==1
    assert client.put('/api/v7/admin/products/pro/metadata',json=change).status_code==200
    with pytest.raises(Exception,match='专业会员已停止'):
        referrals.update_campaign(referrals.CampaignInput(skin_feature=''),actor,'恢复活动规则')


def test_metadata_requires_admin_and_rejects_wrong_types_or_arbitrary_resources(admin):
    _,client=admin
    change={'sort_order':1,'giftable':True,'metadata_version':1,'reason':'展示调整'}
    path='/api/v7/admin/products/cosmic/metadata'
    with TestClient(server.app) as guest:
        assert guest.put(path,json=change).status_code==401
    assert db.create_user('13500000004','ordinary','test-password')[0]
    with TestClient(server.app) as regular:
        regular.post('/api/login',json={'phone':'13500000004','password':'test-password'})
        assert regular.put(path,json=change).status_code==403
    for bad in ({**change,'giftable':'false'},{**change,'sort_order':True},{**change,'sort_order':1000},
                {**change,'reason':'  '},{**change,'resource':'arbitrary-script'}):
        assert client.put(path,json=bad).status_code==422
    assert client.put('/api/v7/admin/products/not-delivered/metadata',json=change).status_code==404
