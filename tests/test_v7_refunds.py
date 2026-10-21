"""Offline signed-gateway tests. No merchant or browser connection is used."""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import httpx
import pytest
from fastapi.testclient import TestClient

import db
import server
import v6_commerce as commerce
import v6_engine as engine
import v6_payments as pay
from test_payments import merchant, notification, _sign


@pytest.fixture
def paid(merchant):
    assert db.create_user('19900008971', 'refund-buyer', 'test-password')[0]
    uid = db.authenticate('19900008971', 'test-password')['id']
    created = pay.checkout(f'user:{uid}', 'cosmic', 'refund-request-fixture')
    pay.settle(notification(created, merchant['alipay_private']))
    return pay.order(f'user:{uid}', created['order_no'])


def signed(method, payload, merchant):
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    envelope = '{"' + method.replace('.', '_') + '_response":' + raw + ',"sign":"' + _sign(raw.encode(), merchant['alipay_private']) + '"}'
    return httpx.Response(200, text=envelope, request=httpx.Request('POST', 'https://example.test'))


def gateway(monkeypatch, merchant, paid, behavior=None):
    calls = []

    def post(url, data, timeout):
        method, biz = data['method'], json.loads(data['biz_content'])
        calls.append((method, biz))
        payload = {'code': '10000', 'out_trade_no': paid['order_no'], 'trade_no': 'trade-' + paid['order_no']}
        if method == 'alipay.trade.query':
            payload.update(total_amount='9.90', trade_status='TRADE_SUCCESS')
        elif method == 'alipay.trade.refund':
            payload.update(refund_fee='9.90', fund_change='Y')
        elif method == 'alipay.trade.fastpay.refund.query':
            payload.update(out_request_no=biz['out_request_no'], total_amount='9.90', refund_amount='9.90', refund_status='REFUND_SUCCESS')
        else:
            pytest.fail('Unexpected gateway call: ' + method)
        if behavior:
            changed = behavior(method, biz, payload)
            if isinstance(changed, httpx.Response):
                return changed
        return signed(method, payload, merchant)

    monkeypatch.setattr(pay.httpx, 'post', post)
    return calls


def act(paid, action='submit', reason='用户申请退款'):
    return pay.admin_refund(paid['order_no'], 1, action=action, reason=reason, expected_amount=paid['amount'])


def release_wait(paid):
    # Simulate passage of the documented retry interval without slow sleeps.
    with db.conn() as c:
        c.execute('UPDATE v6_refund_requests SET next_attempt_at=0,lease_until=0 WHERE order_no=?', (paid['order_no'],))


def test_full_refund_is_signed_audited_idempotent_and_preserves_other_sources(merchant, paid, monkeypatch):
    owner = pay.refund_detail(paid['order_no'])['order']['owner']
    uid = int(owner.split(':')[1])
    code = commerce.generate_cards('cosmic', 30, 1, '赠送月卡', '测试', None, uid, pay.CATALOG)['codes'][0]
    commerce.redeem_card(code, uid)
    calls = gateway(monkeypatch, merchant, paid)
    monkeypatch.setenv('V6_SALES_ENABLED', '0')
    first = act(paid)
    assert first['order']['state'] == 'refunded' and first['request']['state'] == 'succeeded'
    assert not first['request']['processing']
    assert act(paid)['request']['request_no'] == first['request']['request_no']
    assert [m for m, _ in calls] == ['alipay.trade.query', 'alipay.trade.refund']
    details = commerce.entitlement_details(owner)
    assert 'cosmic' in engine.features(owner)
    sources = details['sources']
    assert next(x for x in sources if x['source'] == paid['order_no'])['revoked']
    assert any(x['source_kind'] == 'card' and x['active'] for x in sources)
    with db.conn() as c:
        assert c.execute("SELECT COUNT(*) FROM v6_payment_events WHERE event='full_refund'").fetchone()[0] == 1
        assert c.execute("SELECT COUNT(*) FROM admin_audit WHERE action='order_refund_confirmed'").fetchone()[0] == 1


def test_timeout_then_query_confirms_original_request_without_second_refund(merchant, paid, monkeypatch):
    def timeout(method, biz, payload):
        if method == 'alipay.trade.refund':
            raise httpx.ReadTimeout('response lost after provider accepted it')
    calls = gateway(monkeypatch, merchant, paid, timeout)
    unknown = act(paid)
    assert unknown['request']['state'] == 'unknown' and unknown['order']['state'] == 'paid'
    assert not unknown['request']['processing']
    assert pay.admin_issue_counts()['refund_pending'] == 1
    assert pay.admin_orders(issue='refund_pending')['total'] == 1
    release_wait(paid)
    final = act(paid, 'query', '')
    assert final['request']['state'] == 'succeeded'
    assert calls[1][1]['out_request_no'] == calls[2][1]['out_request_no']
    assert len([m for m, _ in calls if m == 'alipay.trade.refund']) == 1
    assert pay.admin_issue_counts()['refund_pending'] == 0


def test_failed_request_retries_with_identical_amount_key_and_original_reason(merchant, paid, monkeypatch):
    fail = [True]
    def behavior(method, biz, payload):
        if method.endswith('refund.query'):
            payload.pop('refund_status')
        if method == 'alipay.trade.refund' and fail[0]:
            payload.update(code='40004', sub_code='ACQ.BUYER_BALANCE_NOT_ENOUGH')
    calls = gateway(monkeypatch, merchant, paid, behavior)
    assert act(paid)['request']['state'] == 'failed'
    with pytest.raises(engine.DomainError, match='十秒'):
        act(paid)
    assert len(calls) == 2
    release_wait(paid)
    fail[0] = False
    assert act(paid, reason='管理员再次确认')['request']['state'] == 'succeeded'
    requests = [biz for method, biz in calls if method == 'alipay.trade.refund']
    assert len(requests) == 2 and requests[0] == requests[1]


@pytest.mark.parametrize('field,value', [('out_trade_no', 'other'), ('trade_no', 'other'), ('refund_fee', '1.00'), ('app_id', 'other'), ('seller_id', 'other')])
def test_mismatched_signed_response_does_not_revoke(merchant, paid, monkeypatch, field, value):
    def mismatch(method, biz, payload):
        if method == 'alipay.trade.refund':
            payload[field] = value
    gateway(monkeypatch, merchant, paid, mismatch)
    result = act(paid)
    assert result['request']['state'] == 'unknown'
    assert result['order']['state'] == 'paid'
    assert 'cosmic' in engine.features(result['order']['owner'])


def test_signature_tampering_and_query_success_without_refund_status_are_not_success(merchant, paid, monkeypatch):
    def tamper(method, biz, payload):
        if method == 'alipay.trade.refund':
            response = signed(method, payload, merchant)
            return httpx.Response(200, text=response.text.replace('9.90', '0.01'), request=response.request)
        if method.endswith('refund.query'):
            payload.pop('refund_status')
    calls = gateway(monkeypatch, merchant, paid, tamper)
    assert act(paid)['request']['state'] == 'unknown'
    release_wait(paid)
    current = act(paid, 'query', '')
    assert current['request']['state'] == 'unknown' and current['order']['state'] == 'paid'
    assert not current['request']['processing']
    assert len(calls) == 3


def test_no_fund_change_waits_for_query_and_checks_request_identity(merchant, paid, monkeypatch):
    def behavior(method, biz, payload):
        if method == 'alipay.trade.refund':
            payload['fund_change'] = 'N'
        elif method.endswith('refund.query'):
            payload['out_request_no'] = 'different-refund'
    gateway(monkeypatch, merchant, paid, behavior)
    assert act(paid)['order']['state'] == 'paid'
    release_wait(paid)
    assert act(paid, 'query', '')['request']['state'] == 'unknown'


def test_concurrent_requests_make_one_gateway_refund(merchant, paid, monkeypatch):
    entered, proceed = Event(), Event()
    def waiting(method, biz, payload):
        if method == 'alipay.trade.refund':
            entered.set()
            assert proceed.wait(10)
    calls = gateway(monkeypatch, merchant, paid, waiting)
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(act, paid)
        assert entered.wait(10)
        try:
            with pytest.raises(engine.DomainError, match='十秒'):
                act(paid)
        finally:
            proceed.set()
        assert future.result()['request']['state'] == 'succeeded'
    assert len([m for m, _ in calls if m == 'alipay.trade.refund']) == 1


def test_local_commit_failure_recovers_with_query_and_does_not_repeat_refund(merchant, paid, monkeypatch):
    calls = gateway(monkeypatch, merchant, paid)
    with db.conn() as c:
        c.execute("CREATE TRIGGER fail_revoke BEFORE INSERT ON v6_entitlement_revocations BEGIN SELECT RAISE(ABORT, 'test interrupted'); END")
    with pytest.raises(sqlite3.IntegrityError, match='test interrupted'):
        act(paid)
    current = pay.refund_detail(paid['order_no'])
    assert current['order']['state'] == 'paid' and current['request']['state'] != 'succeeded'
    assert not current['request']['processing']
    with db.conn() as c:
        c.execute('DROP TRIGGER fail_revoke')
    release_wait(paid)
    assert act(paid, 'query', '')['order']['state'] == 'refunded'
    assert len([m for m, _ in calls if m == 'alipay.trade.refund']) == 1


@pytest.mark.parametrize('status,refund,expected', [('TRADE_SUCCESS', '1.00', 'paid'), ('TRADE_CLOSED', None, 'refunded')])
def test_preflight_existing_refund_never_sends_another_refund(merchant, paid, monkeypatch, status, refund, expected):
    def behavior(method, biz, payload):
        if method == 'alipay.trade.query':
            payload['trade_status'] = status
            if refund:
                payload['refund_fee'] = refund
    calls = gateway(monkeypatch, merchant, paid, behavior)
    assert act(paid)['order']['state'] == expected
    assert [m for m, _ in calls] == ['alipay.trade.query']
    if refund:
        with pytest.raises(engine.DomainError, match='人工复核'):
            act(paid)


def test_configuration_and_amount_validation_precede_gateway(merchant, paid, monkeypatch):
    calls = gateway(monkeypatch, merchant, paid)
    with pytest.raises(engine.DomainError, match='完整退款金额'):
        pay.admin_refund(paid['order_no'], 1, action='submit', reason='用户申请', expected_amount=1)
    monkeypatch.setenv('ALIPAY_APP_ID', 'other-app')
    with pytest.raises(engine.DomainError, match='原订单不一致'):
        act(paid)
    assert not calls and pay.refund_detail(paid['order_no'])['request'] is None


def test_refund_routes_require_admin_and_reject_arbitrary_amount_fields(merchant, paid, monkeypatch):
    assert db.create_user('19900008972', 'refund-admin', 'test-password')[0]
    admin_id = db.authenticate('19900008972', 'test-password')['id']
    with db.conn() as c:
        c.execute("UPDATE users SET role='superadmin' WHERE id=?", (admin_id,))
    gateway(monkeypatch, merchant, paid)
    url = f"/api/v7/admin/orders/{paid['order_no']}/refund"
    body = {'action': 'submit', 'reason': '用户申请退款', 'expected_amount': 990}
    with TestClient(server.app, base_url='https://lottery.example.test') as client:
        assert client.get(url).status_code == 401
        assert client.post('/api/login', json={'phone':'19900008971', 'password':'test-password'}).status_code == 200
        assert client.get(url).status_code == 403 and client.post(url, json=body).status_code == 403
        assert client.post('/api/login', json={'phone':'19900008972', 'password':'test-password'}).status_code == 200
        assert client.get(url).json()['can_refund']
        assert client.post(url, json={**body, 'refund_amount': 1}).status_code == 422
        assert client.post(url, json={**body, 'reason': ' '}).status_code == 400
        assert client.post(url, json=body).json()['request']['state'] == 'succeeded'
    with db.conn() as c:
        assert c.execute("SELECT actor_id FROM admin_audit WHERE action='order_refund_submit'").fetchone()[0] == admin_id


@pytest.mark.parametrize('field,value', [('refund_amount','0.10'),('total_amount','10.00')])
def test_query_amount_mismatch_cannot_confirm_refund(merchant, paid, monkeypatch, field, value):
    def behavior(method, biz, payload):
        if method == 'alipay.trade.refund':
            payload['fund_change'] = 'N'
        if method.endswith('refund.query'):
            payload[field] = value
    gateway(monkeypatch, merchant, paid, behavior)
    act(paid)
    release_wait(paid)
    result = act(paid, 'query', '')
    assert result['request']['state'] == 'unknown' and result['order']['state'] == 'paid'


def test_refund_schema_migration_preserves_existing_order_and_request(merchant, paid, monkeypatch):
    calls = gateway(monkeypatch, merchant, paid)
    with db.conn() as c:
        c.execute('DROP TABLE v6_refund_requests')
        original = tuple(c.execute('SELECT * FROM v6_orders WHERE order_no=?', (paid['order_no'],)).fetchone())
    pay.init_schema()
    assert pay.refund_detail(paid['order_no'])['request'] is None
    with db.conn() as c:
        assert tuple(c.execute('SELECT * FROM v6_orders WHERE order_no=?', (paid['order_no'],)).fetchone()) == original
    first = act(paid)
    pay.init_schema()
    assert pay.refund_detail(paid['order_no'])['request'] == first['request']
    assert len(calls) == 2


def test_process_restart_recovers_expired_inflight_lease_by_query(merchant, paid, monkeypatch):
    def behavior(method, biz, payload):
        if method == 'alipay.trade.refund':
            raise httpx.ReadTimeout('provider accepted before crash')
    calls = gateway(monkeypatch, merchant, paid, behavior)
    first = act(paid)
    with db.conn() as c:
        c.execute("UPDATE v6_refund_requests SET state='processing',lease_token='old-process',lease_until=1,next_attempt_at=1")
    result = act(paid)
    assert result['order']['state'] == 'refunded'
    assert result['request']['request_no'] == first['request']['request_no']
    assert len([m for m, _ in calls if m == 'alipay.trade.refund']) == 1
