#!/usr/bin/env python3
"""Mock upstream for the route-integrity drill.

Classifies the caller by its bearer token into one of four behaviours, so the
router's failover can be observed without touching any real provider:

  ft-key-live  -> 200 (a working account)
  ft-key-dead  -> 401 (revoked / bad credential — the router SHOULD fail over)
  ft-key-rl    -> 429 (rate limited — a per-account condition; does it fail over?)
  ft-key-br    -> 503 (upstream broken — provider-wide; does it fail over?)

Every hit is appended to the log file given by --log, one line per request:
  <unix_ms> <status> <key> <model>
so the test can assert WHICH accounts were tried and in WHAT ORDER.
"""
import json
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2] if len(sys.argv) > 2 else "/tmp/ftest-upstream.log"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8201

BEHAVIOUR = {
    "ft-key-live": 200,
    "ft-key-dead": 401,
    "ft-key-rl": 429,
    "ft-key-br": 503,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the drill output clean
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        try:
            req = json.loads(body or b"{}")
        except Exception:
            req = {}
        auth = self.headers.get("Authorization", "")
        key = auth.removeprefix("Bearer ").strip()
        model = req.get("model", "?")
        status = BEHAVIOUR.get(key, 404)

        if key == "ft-key-drop":
            # Transport failure: log it, answer nothing, slam the connection
            # so the client sees EOF instead of a status line.
            with open(LOG, "a") as fh:
                fh.write(f"{int(time.time() * 1000)} ERR {key} {model}\n")
            self.close_connection = True
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return

        with open(LOG, "a") as fh:
            fh.write(f"{int(time.time() * 1000)} {status} {key} {model}\n")

        if status == 200:
            payload = {
                "id": "chatcmpl-ftest",
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "PONG"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 4,
                    "completion_tokens": 2,
                    "total_tokens": 6,
                },
            }
            self._send(200, json.dumps(payload).encode())
            return

        msg = {
            401: "invalid api key",
            429: "rate limit exceeded",
            503: "service temporarily unavailable",
        }.get(status, "unknown model")
        self._send(status, json.dumps({"error": {"message": msg, "type": "mock"}}).encode())

    def do_GET(self):
        # /v1/models — the router probes nothing here, but the admin page does.
        self._send(
            200,
            json.dumps({"object": "list", "data": [{"id": "ftest-ok", "object": "model"}]}).encode(),
        )

    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    open(LOG, "w").close()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock upstream on 127.0.0.1:{PORT}, log {LOG}", flush=True)
    srv.serve_forever()
