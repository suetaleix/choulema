import copy
import time

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import db
import server
import v7_catalog as catalog
import v6_commerce as commerce
import v6_engine as engine
import v6_payments as payments
import v7_referrals as referrals


@pytest.fixture
def expanded(monkeypatch):
    data = copy.deepcopy(catalog.CONTENT)
    data['machines']['sample_machine'] = {**data['machines']['sphere'], 'name': '扩展示例机台', 'feature': 'sample_machine'}
    for theme in data['themes'].values():
        theme['machines'].append('sample_machine')
    data['products']['cosmic']['machines'].append('sample_machine')
    data['themes']['sample_theme'] = {**data['themes']['cosmic'], 'name': '扩展示例主题', 'feature': 'sample_theme'}
    data['products']['sample_machine'] = {'name': '扩展示例机台', 'feature': 'sample_machine', 'kind': 'machine', 'target': 'sample_machine', 'machines': ['sample_machine'], 'days': 365, 'price_cents': 1000}
    data['products']['sample_theme'] = {'name': '扩展示例主题', 'feature': 'sample_theme', 'kind': 'skin', 'target': 'sample_theme', 'machines': data['themes']['sample_theme']['machines'], 'days': 365, 'price_cents': 1000}
    data['capabilities']['result_export']['features'].append('sample_pack')
    data['products']['sample_pack'] = {'name': '扩展示例功能', 'feature': 'sample_pack', 'kind': 'feature', 'capabilities': ['result_export'], 'machines': ['sphere'], 'days': 365, 'price_cents': 1000}
    catalog.validate_catalog(data)
    monkeypatch.setattr(catalog, 'CONTENT', data)
    monkeypatch.setattr(catalog, 'PRODUCTS', data['products'])
    monkeypatch.setattr(payments, 'CATALOG', data['products'])
    payments.init_schema()
    return data


def user():
    assert db.create_user('13500009901', 'release-user', 'test-password')[0]
    return db.authenticate('13500009901', 'test-password')['id']


def grant_card(uid, feature):
    batch = commerce.generate_cards(feature, 30, 1, '扩展验收', '仅测试', None, uid, payments.CATALOG)
    return commerce.redeem_card(batch['codes'][0], uid)


def test_new_machine_theme_and_feature_use_shared_cards_and_authorization(expanded, cfg):
    uid = user()
    owner = f'user:{uid}'
    config = engine.DrawConfig.model_validate({**cfg.model_dump(), 'machine': 'sample_machine', 'theme': 'sample_theme', 'sound': 'slot-cosmic2'})
    with pytest.raises(engine.DomainError):
        engine.new_run(owner, config)
    engine.new_run(owner, config, rehearsal=True)
    grant_card(uid, 'sample_machine')
    with pytest.raises(engine.DomainError):
        engine.new_run(owner, config)
    grant_card(uid, 'sample_theme')
    run = engine.new_run(owner, config)
    assert engine.draw(owner, run['id'], 'sample-request', run['control_token'])['results']
    assert not engine.has_capability(owner, 'result_export')
    grant_card(uid, 'sample_pack')
    assert engine.has_capability(owner, 'result_export')
    assert not engine.has_capability(owner, 'branding')
    assert 'sample_theme' in {s['feature'] for s in referrals.skins()}
    assert 'sample_machine' not in {s['feature'] for s in referrals.skins()}


def test_delisting_and_emergency_disable_are_distinct_and_preserve_runs(cfg):
    uid = user()
    owner = f'user:{uid}'
    grant_card(uid, 'cosmic')
    config = cfg.model_copy(update={'theme': 'cosmic'})
    run = engine.new_run(owner, config)
    commerce.set_product('cosmic', 2500, False, uid, '下架测试', payments.CATALOG)
    engine.draw(owner, run['id'], 'after-delisting', run['control_token'])
    before = engine.get_run(owner, run['id'])
    catalog.update_state('themes', 'cosmic', False, 1, '紧急维护测试', uid)
    with pytest.raises(engine.DomainError):
        engine.draw(owner, run['id'], 'after-disable', run['control_token'])
    with pytest.raises(engine.DomainError):
        engine.new_run(owner, config, rehearsal=True)
    assert engine.get_run(owner, run['id']) == before
    assert 'cosmic' in engine.features(owner)
    with pytest.raises(engine.DomainError) as conflict:
        catalog.update_state('themes', 'cosmic', True, 1, '过期操作', uid)
    assert conflict.value.status == 409
    catalog.update_state('themes', 'cosmic', True, 2, '恢复使用', uid)
    assert engine.draw(owner, run['id'], 'after-enable', run['control_token'])['results']
    payments.init_schema()
    product = next(p for p in payments.catalog(owner) if p['slug'] == 'cosmic')
    assert product['price_cents'] == 2500 and not product['sale_visible']
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='content_availability'").fetchone()[0] == 2


def test_capability_disable_applies_to_existing_holders_and_rehearsals(cfg):
    uid = user()
    grant_card(uid, 'pro')
    assert engine.has_capability(f'user:{uid}', 'branding')
    catalog.update_state('capabilities', 'branding', False, 1, '维护测试', uid)
    assert not engine.has_capability(f'user:{uid}', 'branding')
    with pytest.raises(engine.DomainError):
        engine.new_run(f'user:{uid}', cfg.model_copy(update={'brand': '测试'}), rehearsal=True)
    assert engine.new_run(f'user:{uid}', cfg)['id']


def test_public_catalog_and_admin_mutation_permission():
    uid = user()
    body = {'enabled': False, 'version': 1, 'reason': '维护验证'}
    path = '/api/v7/admin/catalog/themes/cosmic'
    with TestClient(server.app) as client:
        assert client.get('/api/v7/catalog').json()['themes']['classic']['enabled']
        assert client.put(path, json=body).status_code == 401
        client.post('/api/login', json={'phone': '13500009901', 'password': 'test-password'})
        assert client.put(path, json=body).status_code == 403
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?", (uid,))
        assert client.put(path, json={**body, 'enabled': 'false'}).status_code == 422
        assert client.put(path, json={**body, 'reason': '  '}).status_code == 422
        assert client.put('/api/v7/admin/catalog/themes/nonexistent', json=body).status_code == 404
        assert client.put(path, json=body).status_code == 200
        assert client.put(path, json=body).status_code == 409


def test_unknown_and_incompatible_appearance_rejected(expanded, cfg):
    for changes in ({'machine': 'unshipped'}, {'theme': 'unshipped'}, {'sound': 'slot-cosmic1'}, {'machine': 'wheel', 'count': 2}):
        with pytest.raises(ValidationError):
            engine.DrawConfig.model_validate({**cfg.model_dump(), **changes})
    expanded['themes']['sample_theme']['machines'] = ['sample_machine']
    with pytest.raises(ValidationError):
        engine.DrawConfig.model_validate({**cfg.model_dump(), 'theme': 'sample_theme'})


def test_existing_pro_does_not_grant_future_paid_machine_or_theme(expanded, cfg):
    uid = user()
    grant_card(uid, 'pro')
    assert not {'sample_machine', 'sample_theme', 'sample_pack'}.intersection(engine.features(f'user:{uid}'))
    assert engine.has_capability(f'user:{uid}', 'result_export')


def test_expired_extension_retains_config_and_history(expanded, cfg):
    uid = user()
    owner = f'user:{uid}'
    grant_card(uid, 'sample_machine')
    config = cfg.model_copy(update={'machine': 'sample_machine'})
    engine.save_config(owner, config)
    run = engine.new_run(owner, config)
    engine.draw(owner, run['id'], 'first-result', run['control_token'])
    before = engine.get_run(owner, run['id'])
    with db.conn() as c:
        c.execute("UPDATE v6_entitlements SET expires_at=? WHERE owner=?", (int(time.time()) - 1, owner))
    with pytest.raises(engine.DomainError):
        engine.draw(owner, run['id'], 'expired-result', run['control_token'])
    assert engine.get_run(owner, run['id']) == before
    assert engine.list_configs(owner)
    engine.change_appearance(owner, run['id'], run['control_token'], 'sphere', 'classic', 'slot-default1')
    assert engine.draw(owner, run['id'], 'free-result', run['control_token'])['results']
