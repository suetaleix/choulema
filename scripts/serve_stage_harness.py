"""Loopback-only rendering fixtures; no app, database, or draw endpoints."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mimetypes
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MOUNTS = {
    'fixtures': ROOT / 'tests' / 'fixtures',
    'v6': ROOT / 'static' / 'v6',
    'vendor': ROOT / 'static' / 'vendor',
}
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('text/javascript', '.js')


def resolve_asset(url):
    request_path = unquote(urlsplit(url).path)
    if request_path == '/':
        request_path = '/fixtures/stage-harness.html'
    parts = request_path.lstrip('/').split('/', 1)
    if len(parts) != 2 or parts[0] not in MOUNTS:
        return None
    base = MOUNTS[parts[0]].resolve()
    candidate = (base / parts[1]).resolve()
    if not candidate.is_relative_to(base) or not candidate.is_file():
        return None
    return candidate


class Handler(BaseHTTPRequestHandler):
    def serve_asset(self, head=False):
        asset = resolve_asset(self.path)
        if asset is None:
            self.send_error(404)
            return
        content = asset.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(asset)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if not head:
            self.wfile.write(content)

    def do_GET(self):
        self.serve_asset()

    def do_HEAD(self):
        self.serve_asset(head=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8903)
    args = parser.parse_args()
    with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
        print(f'Rendering fixtures: http://127.0.0.1:{args.port}/?diagnostics=1', flush=True)
        server.serve_forever()
