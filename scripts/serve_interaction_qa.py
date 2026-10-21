"""Isolated ASGI fault harness for the VU-11 browser checks.

Run on loopback with a fresh LOTTERY_DB. This wrapper changes only latency
and the first draw response; the production app and database code are reused.
"""

import asyncio
import os

from server import app as product_app


class InteractionQaApp:
    def __init__(self):
        self.delay = max(0.0, min(10.0, float(os.getenv("QA_DELAY_START_SECONDS", "0"))))
        self.fail_draw_once = os.getenv("QA_FAIL_DRAW_ONCE") == "1"
        self._lock = asyncio.Lock()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope["path"]
            if path.startswith("/api/v6/runs/") and path.endswith("/start"):
                await asyncio.sleep(self.delay)
            if path.startswith("/api/v6/runs/") and path.endswith("/draw"):
                async with self._lock:
                    should_fail = self.fail_draw_once
                    self.fail_draw_once = False
                if should_fail:
                    body = b'{"detail":"QA injected draw failure"}'
                    await send({"type": "http.response.start", "status": 503,
                                "headers": [(b"content-type", b"application/json"),
                                            (b"content-length", str(len(body)).encode())]})
                    await send({"type": "http.response.body", "body": body})
                    return
        await product_app(scope, receive, send)


app = InteractionQaApp()
