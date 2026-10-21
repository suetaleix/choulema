"""Small HTTP boundary shared by local and production deployments.

Body limits run before parsing JSON/multipart, including chunked requests.
The payment notification remains server-to-server and is verified by RSA2.
"""
import base64
import hashlib
import os
from urllib.parse import urlsplit

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse

MAX_BODY = 4 * 1024 * 1024
SMALL_BODY_PATHS = {'/api/login', '/api/register', '/api/register/email-code', '/api/password/change', '/api/feedback', '/api/v7/feedback',
                    '/api/v6/cards/redeem', '/api/v6/checkout', '/api/v6/payment/notify'}
IMPORT_MAP = '{"imports":{"three":"/vendor/three.module.js"}}'
IMPORT_HASH = base64.b64encode(hashlib.sha256(IMPORT_MAP.encode()).digest()).decode()
CORE_PAGES = {'/', '/login.html', '/play.html', '/admin.html'}


def canonical_origin(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return None


def trusted_mutation(request):
    """Same-site subdomains are not automatically trusted origins."""
    if request.headers.get('sec-fetch-site') == 'cross-site':
        return False
    expected = str(request.base_url)
    if os.getenv('LOTTERY_ENV') == 'production' and os.getenv('LOTTERY_PUBLIC_URL'):
        expected = os.environ['LOTTERY_PUBLIC_URL']
    supplied = request.headers.get('origin') or request.headers.get('referer')
    # Non-browser clients need no fabricated Origin. Cookie clients retain Lax.
    return not supplied or canonical_origin(supplied) == canonical_origin(expected) is not None


class SecurityBoundaryMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path = scope.get('path', '')

        async def secured_send(message):
            if message['type'] == 'http.response.start':
                headers = MutableHeaders(scope=message)
                headers['X-Content-Type-Options'] = 'nosniff'
                headers['X-Frame-Options'] = 'DENY'
                headers['Referrer-Policy'] = 'same-origin'
                headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
                csp = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
                if path in CORE_PAGES:
                    csp += (f"; default-src 'self'; script-src 'self' 'sha256-{IMPORT_HASH}'"
                            "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:"
                            "; media-src 'self' blob:; connect-src 'self'; font-src 'self'; form-action 'self'")
                headers['Content-Security-Policy'] = csp
                if path.startswith('/api/'):
                    headers['Cache-Control'] = 'private, no-store'
            await send(message)

        async def reject(status, text):
            await JSONResponse({'error': text}, status_code=status)(scope, receive, secured_send)

        if os.getenv('LOTTERY_ENV') == 'production' and path in {'/docs', '/redoc', '/openapi.json', '/docs/oauth2-redirect'}:
            return await reject(404, '页面不存在')
        if path.startswith('/api/') and scope.get('method') in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            limit = 16 * 1024 if path in SMALL_BODY_PATHS else MAX_BODY
            headers = Headers(scope=scope)
            try:
                declared = int(headers.get('content-length', '0'))
                if declared < 0:
                    raise ValueError
            except ValueError:
                return await reject(400, '请求长度不正确')
            if declared > limit:
                return await reject(413, '请求内容过大，请缩小文件或名单后重试')
            chunks, size = [], 0
            while True:
                message = await receive()
                if message['type'] == 'http.disconnect':
                    return
                chunk = message.get('body', b'')
                size += len(chunk)
                if size > limit:
                    return await reject(413, '请求内容过大，请缩小文件或名单后重试')
                chunks.append(chunk)
                if not message.get('more_body', False):
                    break
            body = b''.join(chunks)
            delivered = False

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': body, 'more_body': False}
                return await receive()

            return await self.app(scope, bounded_receive, secured_send)
        return await self.app(scope, receive, secured_send)
