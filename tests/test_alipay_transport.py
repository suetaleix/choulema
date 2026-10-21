"""Regression for the production gateway's URL-selected POST charset."""
import base64
import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

import v6_payments as pay
from v6_engine import DomainError
from test_payments import merchant, _sign


def mock_gateway(monkeypatch, merchant, payload, *, tamper=False):
    def post(url, data, timeout):
        query = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
        params = {**data, **query}
        merchant['merchant_private'].public_key().verify(
            base64.b64decode(params['sign']), pay._canonical(params).encode('utf-8'),
            padding.PKCS1v15(), hashes.SHA256())
        # Reproduce the real gateway: body-only charset still selects GBK.
        charset = query.get('charset', 'gbk')
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        signature = _sign(raw.encode(charset), merchant['alipay_private'])
        if tamper:
            raw = raw.replace('交易不存在', '交易已经存在')
        key = data['method'].replace('.', '_') + '_response'
        body = '{"' + key + '":' + raw + ',"sign":"' + signature + '"}'
        return httpx.Response(200, content=body.encode(charset),
                              headers={'Content-Type': 'text/html;charset=' + charset},
                              request=httpx.Request('POST', url))
    monkeypatch.setattr(pay.httpx, 'post', post)


@pytest.mark.parametrize('method', ['alipay.trade.query', 'alipay.trade.refund',
                                   'alipay.trade.fastpay.refund.query'])
def test_signed_chinese_gateway_responses(merchant, monkeypatch, method):
    payload = {'code': '10000', 'out_trade_no': 'transport-check', 'msg': '处理成功'}
    mock_gateway(monkeypatch, merchant, payload)
    if method == 'alipay.trade.query':
        result = pay._query_order('transport-check', pay.settings())
    else:
        result = pay._refund_gateway(method, {'out_trade_no': 'transport-check',
                                             'refund_reason': '用户申请退款'}, pay.settings())
    assert result == payload


@pytest.mark.parametrize('tamper', [False, True])
def test_missing_trade_is_only_accepted_after_verification(merchant, monkeypatch, tamper):
    payload = {'code': '40004', 'sub_code': 'ACQ.TRADE_NOT_EXIST', 'sub_msg': '交易不存在'}
    mock_gateway(monkeypatch, merchant, payload, tamper=tamper)
    if tamper:
        with pytest.raises(DomainError, match='签名校验失败'):
            pay._query_order('missing-trade', pay.settings())
    else:
        assert pay._query_order('missing-trade', pay.settings()) is None
