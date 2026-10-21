"""Product journeys through HTTP APIs, not browser or live-money acceptance."""
import time
from itertools import product

import pytest
from fastapi.testclient import TestClient

import db
import server
from test_payments import merchant, notification
from test_v7_refunds import gateway


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def account(client, number, admin=False):
    phone = f'1990000{number:04d}'
    assert db.create_user(phone, f'journey{number}', 'journey-test-password')[0]
    uid = db.authenticate(phone, 'journey-test-password')['id']
    if admin:
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?", (uid,))
    ok(client.post('/api/login', json={'phone': phone, 'password': 'journey-test-password'}))
    return uid


def draw(client, config, rehearsal=False, request='journey-draw-001'):
    run = ok(client.post('/api/v6/runs', json={'config': config, 'rehearsal': rehearsal}))
    payload = {'request_id': request, 'control_token': run['control_token']}
    ok(client.post(f"/api/v6/runs/{run['id']}/start", json=payload))
    assert ok(client.get(f"/api/v6/runs/{run['id']}"))['presentation']['phase'] == 'spinning'
    result = ok(client.post(f"/api/v6/runs/{run['id']}/draw", json=payload))
    assert result == ok(client.post(f"/api/v6/runs/{run['id']}/draw", json=payload))
    state = ok(client.get(f"/api/v6/runs/{run['id']}"))
    assert state['presentation']['phase'] == 'revealed' and len(state['draws']) == 1
    assert result['results'][0]['id'] in {'a', 'b', 'c'}
    return run, result


@pytest.mark.parametrize('app,machine', list(product(['food', 'play', 'person', 'prize'], ['capsule', 'wheel', 'sphere'])))
def test_every_scene_machine_theme_and_approved_sound(app, machine):
    config = {'app': app, 'machine': machine, 'items': [{'id': x, 'name': name} for x, name in zip('abc', ['同名', '同名', '中英文 Emoji 🐎'])]}
    with TestClient(server.app) as user, TestClient(server.app) as admin:
        for index in range(1, 4):
            draw(user, {**config, 'theme': 'classic', 'sound': f'slot-default{index}'})
        for index in range(1, 4):
            skin = {**config, 'theme': 'cosmic', 'sound': f'slot-cosmic{index}'}
            assert user.post('/api/v6/runs', json={'config': skin}).status_code == 403
            draw(user, skin, rehearsal=True)
        account(user, 8802)
        account(admin, 8803, True)
        batch = ok(admin.post('/api/v6/admin/card-batches', json={'feature': 'cosmic', 'days': 30, 'quantity': 1, 'label': '本地皮肤体验'}))
        ok(user.post('/api/v6/cards/redeem', json={'code': batch['codes'][0]}))
        for index in range(1, 4):
            draw(user, {**config, 'theme': 'cosmic', 'sound': f'slot-cosmic{index}'})


def test_invite_registration_card_upgrade_saved_class_and_admin_account_lifecycle(email_registration):
    with TestClient(server.app) as inviter, TestClient(server.app) as invited, TestClient(server.app) as admin:
        inviter_id = account(inviter, 8804)
        account(admin, 8805, True)
        code = ok(inviter.get('/api/v7/referrals/me'))['code']
        ok(invited.get('/api/v6/status'))
        assert ok(invited.post('/api/v7/referrals/visit', json={'code': code}))['attributed']
        ok(invited.post('/api/register', json=email_registration(invited, 'invited8806@example.test', 'invited8806', 'journey-test-password')))
        ok(invited.post('/api/login', json={'identifier': 'invited8806@example.test', 'password': 'journey-test-password'}))
        uid = ok(invited.get('/api/me'))['user']['id']
        assert set(ok(inviter.get('/api/v6/status'))['features']) == {'pro', 'cosmic'}
        assert ok(invited.get('/api/v6/status'))['features'] == []
        assert ok(inviter.get('/api/v7/referrals/me'))['completed_this_month'] == 1
        assert ok(admin.get('/api/v7/admin/referrals'))['total'] == 1
        for feature, days in [('pro', 7), ('cosmic', 90)]:
            batch = ok(admin.post('/api/v6/admin/card-batches', json={'feature': feature, 'days': days, 'quantity': 1, 'label': '独立权益体验'}))
            redeemed = ok(invited.post('/api/v6/cards/redeem', json={'code': batch['codes'][0]}))
            repeated = ok(invited.post('/api/v6/cards/redeem', json={'code': batch['codes'][0]}))
            assert repeated['already_redeemed'] and repeated['expires_at'] == redeemed['expires_at']
        imported = ok(invited.post('/api/v6/import', files={'file': ('class.csv', b'name\nAlice\nBob\nCarol', 'text/csv')}))
        assert len(imported['rows']) == 4
        config = {'app': 'person', 'machine': 'sphere', 'mode': 'no_repeat', 'theme': 'cosmic', 'sound': 'slot-cosmic2', 'title': '本地验收班级', 'items': [{'id': x, 'name': name} for x, name in zip('abc', ['Alice', 'Bob', 'Carol'])]}
        saved = ok(invited.post('/api/v6/configs', json={'config': config}))
        config['source_config_id'] = saved['id']
        run, _ = draw(invited, config)
        exported = invited.get(f"/api/v6/runs/{run['id']}/export")
        assert exported.status_code == 200 and '本地验收班级' in exported.text
        assert ok(invited.get(f"/api/v6/configs/{saved['id']}/report"))['sessions'] == 1
        ok(invited.post('/api/logout'))
        ok(invited.post('/api/login', json={'identifier': 'invited8806@example.test', 'password': 'journey-test-password'}))
        assert ok(invited.get('/api/v6/configs'))['configs'][0]['id'] == saved['id']
        ok(admin.post(f'/api/admin/users/{uid}/status', json={'status': 'disabled'}))
        assert invited.get('/api/me').status_code == 401
        ok(admin.post(f'/api/admin/users/{uid}/status', json={'status': 'active'}))
        ok(invited.post('/api/login', json={'identifier': 'invited8806@example.test', 'password': 'journey-test-password'}))
        assert set(ok(invited.get('/api/v6/status'))['features']) == {'pro', 'cosmic'}
        assert len(ok(admin.get('/api/v6/admin/audit'))['events']) >= 4


@pytest.mark.parametrize('channel', ['pc', 'mobile'])
def test_purchase_notify_owned_skin_full_refund_and_loss_of_access(merchant, monkeypatch, channel):
    # All keys are generated fixtures; gateway calls below are signed local fakes.
    with TestClient(server.app, base_url='https://lottery.example.test') as user, TestClient(server.app, base_url='https://lottery.example.test') as admin, TestClient(server.app) as callback:
        account(user, 8807)
        account(admin, 8808, True)
        product = next(p for p in ok(user.get('/api/v6/shop'))['products'] if p['slug'] == 'cosmic')
        order = ok(user.post('/api/v6/checkout', json={'slug': 'cosmic', 'channel': channel, 'request_id': 'journey-checkout-'+channel, 'price_version': product['price_version']}))
        assert order['state'] == 'pending' and ok(user.get('/api/v6/status'))['features'] == []
        data = notification(order, merchant['alipay_private'])
        assert callback.post('/api/v6/payment/notify', data=data).text == 'success'
        assert callback.post('/api/v6/payment/notify', data=data).text == 'success'
        assert ok(user.get('/api/v6/orders'))['orders'][0]['state'] == 'paid'
        assert ok(user.get('/api/v6/status'))['features'] == ['cosmic']
        account_state = ok(user.get('/api/v6/account'))
        assert len([s for s in account_state['sources'] if s['source'] == order['order_no']]) == 1
        config = {'app': 'food', 'machine': 'capsule', 'theme': 'cosmic', 'sound': 'slot-cosmic1', 'items': [{'id': 'a', 'name': '火锅'}, {'id': 'b', 'name': '米饭'}]}
        draw(user, config)
        calls = gateway(monkeypatch, merchant, order)
        response = ok(admin.post(f"/api/v7/admin/orders/{order['order_no']}/refund", json={'action': 'submit', 'reason': '本地完整流程退款', 'expected_amount': order['amount']}))
        assert response['order']['state'] == 'refunded'
        assert [method for method, _ in calls] == ['alipay.trade.query', 'alipay.trade.refund']
        assert ok(user.get('/api/v6/status'))['features'] == []
        assert user.post('/api/v6/runs', json={'config': config}).status_code == 403
        assert ok(user.get('/api/v6/orders'))['orders'][0]['state'] == 'refunded'
        assert ok(admin.get('/api/v6/admin/orders', params={'state': 'refunded'}))['total'] == 1
