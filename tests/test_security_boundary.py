"""Abuse/security regressions in a disposable database; never target production."""
import asyncio
import base64
import hashlib
import time
from html.parser import HTMLParser
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import db
import server
from request_security import SecurityBoundaryMiddleware


def login(client, admin=False):
    assert db.create_user('19900008801', 'securityaudit', 'test-password')[0]
    uid = db.authenticate('19900008801', 'test-password')['id']
    if admin:
        with db.conn() as c:
            c.execute("UPDATE users SET role='superadmin' WHERE id=?", (uid,))
    assert client.post('/api/login', json={'phone': '19900008801', 'password': 'test-password'}).status_code == 200
    return uid


def test_feedback_submission_daily_limit_and_admin_visibility(monkeypatch):
    import v8_feedback
    from types import SimpleNamespace
    now = int(time.time())
    monkeypatch.setattr(v8_feedback, 'time', SimpleNamespace(time=lambda: now))
    with TestClient(server.app) as client:
        uid = login(client, True)
        for i in range(5):
            now += 31
            response = client.post('/api/feedback', json={'content': f'第{i + 1}条本地产品反馈'})
            assert response.status_code == 200, response.text
        assert client.post('/api/feedback', json={'content': '第六条反馈内容'}).status_code == 429
        rows = client.get('/api/admin/feedback').json()['feedback']
        assert len(rows) == 5 and all(row['subject_id'] == uid for row in rows)
        client.post('/api/logout')
        assert client.get('/api/admin/feedback').status_code == 401


def test_anonymous_and_normal_user_cannot_read_admin_data():
    routes = ['/api/admin/users', '/api/admin/stats', '/api/admin/settings', '/api/admin/feedback',
              '/api/v6/admin/products', '/api/v6/admin/card-batches', '/api/v6/admin/orders',
              '/api/v6/admin/overview', '/api/v6/admin/audit', '/api/v6/admin/users/1/commerce',
              '/api/v7/admin/referrals/settings', '/api/v7/admin/referrals',
              '/api/v7/admin/users/1/referrals', '/api/v7/admin/overview',
              '/api/v7/admin/content', '/api/v7/admin/system',
              '/api/v7/admin/orders/unknown/refund', '/api/v7/admin/operations/tasks/unknown']
    with TestClient(server.app) as client:
        for authenticated in (False, True):
            if authenticated:
                login(client)
            for path in routes:
                response = client.get(path)
                assert response.status_code in {401, 403}, (path, response.text)


@pytest.mark.parametrize('headers', [
    {'Origin': 'https://evil.example'}, {'Origin': 'null'},
    {'Origin': 'https://testserver'}, {'Referer': 'https://evil.example/form'},
    {'Sec-Fetch-Site': 'cross-site'}, {'Origin': 'http://testserver.evil.example'},
])
def test_cross_origin_write_cannot_log_user_out(headers):
    with TestClient(server.app) as client:
        login(client)
        response = client.post('/api/logout', headers=headers)
        assert response.status_code == 403
        assert client.get('/api/me').status_code == 200


def test_same_origin_write_and_originless_server_callback_are_supported():
    with TestClient(server.app) as client:
        login(client)
        assert client.post('/api/logout', headers={'Origin': 'http://testserver:80'}).status_code == 200
        # A callback reaches signature validation; CSRF protection must not reject it.
        response = client.post('/api/v6/payment/notify', data={'sign': 'invalid'}, headers={'Origin': 'https://alipay.com'})
        assert response.status_code == 400 and response.text != 'success'


def test_captcha_expiry_one_time_use_and_memory_cap(monkeypatch):
    monkeypatch.setattr(server, '_CAPTCHA_CAP', 2)
    server._CAPTCHAS['expired'] = ('ZZZZ', time.time() - 1)
    first, code, _ = server._gen_captcha()
    assert 'expired' not in server._CAPTCHAS
    server._gen_captcha()
    with pytest.raises(server.HTTPException) as error:
        server._gen_captcha()
    assert error.value.status_code == 429 and len(server._CAPTCHAS) == 2
    assert server._check_captcha(first, code)
    assert not server._check_captcha(first, code)
    server._gen_captcha()
    assert len(server._CAPTCHAS) == 2


def test_captcha_rate_limit_and_password_limits_run_before_expensive_work(monkeypatch):
    with TestClient(server.app) as client:
        for _ in range(20):
            assert client.get('/api/captcha').status_code == 200
        assert client.get('/api/captcha').status_code == 429
        monkeypatch.setattr(db, 'authenticate', lambda *args: pytest.fail('oversized password reached hashing'))
        assert client.post('/api/login', json={'phone': '19900008801', 'password': 'x' * 129}).status_code == 422
        assert client.post('/api/login', content=b'x' * 17000).status_code == 413
        assert client.get('/api/qr', params={'data': '中' * 501}).status_code == 400


def test_chunked_body_limit_is_checked_before_app_and_cannot_trust_content_length():
    async def attempt(chunks, length=None):
        messages, reached = [], []
        async def endpoint(scope, receive, send):
            reached.append(await receive())
            await send({'type': 'http.response.start', 'status': 204, 'headers': []})
            await send({'type': 'http.response.body', 'body': b''})
        queue = [{'type': 'http.request', 'body': chunk, 'more_body': i < len(chunks)-1} for i, chunk in enumerate(chunks)]
        async def receive():
            return queue.pop(0)
        async def send(message):
            messages.append(message)
        scope = {'type': 'http', 'method': 'POST', 'path': '/api/login', 'headers': []}
        if length is not None:
            scope['headers'] = [(b'content-length', length)]
        await SecurityBoundaryMiddleware(endpoint)(scope, receive, send)
        return messages[0]['status'], reached
    for length in (None, b'1'):
        status, reached = asyncio.run(attempt([b'x'*8192]*3, length))
        assert status == 413 and reached == []
    status, reached = asyncio.run(attempt([b'hello', b'world']))
    assert status == 204 and reached[0]['body'] == b'helloworld'


def test_headers_csp_allow_only_shipped_inline_importmap_and_production_hides_docs(monkeypatch):
    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__(); self.inline = []; self.current = None
        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            assert not any(key.lower().startswith('on') for key in attrs)
            if tag == 'script' and 'src' not in attrs:
                self.current = ''
        def handle_data(self, data):
            if self.current is not None:
                self.current += data
        def handle_endtag(self, tag):
            if tag == 'script' and self.current is not None:
                self.inline.append(self.current); self.current = None
    with TestClient(server.app) as client:
        for name in ('login', 'play', 'admin'):
            response = client.get(f'/{name}.html', follow_redirects=False)
            assert response.headers['X-Content-Type-Options'] == 'nosniff'
            assert response.headers['X-Frame-Options'] == 'DENY'
            csp = response.headers['Content-Security-Policy']
            assert "script-src 'self'" in csp and 'unsafe-eval' not in csp
            parser = Scripts()
            parser.feed((Path(server.__file__).parent / 'static' / f'{name}.html').read_text(encoding='utf-8'))
            for source in parser.inline:
                digest = base64.b64encode(hashlib.sha256(source.encode()).digest()).decode()
                assert f"'sha256-{digest}'" in csp
        monkeypatch.setenv('LOTTERY_ENV', 'production')
        for path in ('/docs', '/redoc', '/openapi.json'):
            assert client.get(path).status_code == 404


def test_https_login_cookie_security_and_old_csv_formula_escaping(monkeypatch):
    monkeypatch.setenv('LOTTERY_PUBLIC_URL', 'https://testserver')
    with TestClient(server.app, base_url='https://testserver') as client:
        uid = login(client, True)
        sid = next(cookie for cookie in client.cookies.jar if cookie.name == 'sid')
        assert sid.secure and sid.has_nonstandard_attr('HttpOnly') and sid.get_nonstandard_attr('SameSite') == 'lax'
        db.log_play(uid, None, '=1+1', '@malicious')
        result = client.get('/api/export')
        assert "'=1+1" in result.text and "'@malicious" in result.text


def test_brand_media_whitelisted_decoders_still_accept_valid_images(monkeypatch):
    import io
    from PIL import Image, EpsImagePlugin
    import v6_engine as engine
    def forbidden(*args, **kwargs):
        pytest.fail('unapproved EPS decoder was instantiated')
    monkeypatch.setattr(EpsImagePlugin.EpsImageFile, '__init__', forbidden)
    config = {'items': [{'id': 'a', 'name': '正常候选'}]}
    for format_name, mime in [('PNG', 'png'), ('JPEG', 'jpeg'), ('WEBP', 'webp')]:
        stream = io.BytesIO()
        Image.new('RGB', (16, 16), '#4488aa').save(stream, format=format_name)
        encoded = 'data:image/'+mime+';base64,'+base64.b64encode(stream.getvalue()).decode()
        assert engine.DrawConfig(**config, logo=encoded).logo == encoded
    disguised = b'%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 16 16\n%%EndComments\n'
    with pytest.raises(ValueError, match='图片'):
        engine.DrawConfig(**config, logo='data:image/png;base64,'+base64.b64encode(disguised).decode())
