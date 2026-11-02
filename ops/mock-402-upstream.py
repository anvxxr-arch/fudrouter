#!/usr/bin/env python3
"""Deterministic 402 upstream for the live per-account failover proof.

The prv_zro pool is FLAKY, not spent: every key alternates 200/402 (measured
14b4b720: 41x200 + 16x402 in 24h), so a synthetic A/B against "the spent key"
can only prove the failover by luck. This mock removes the luck: it answers 402
INSUFFICIENT_CREDITS for the FIRST bearer token it ever sees and 200 for every
other token. With the pool shrunk to two accounts, the head account hits the 402,
the router must rotate to the sibling, and the client must still get a 200 — all
through the real picker, real pool, real ledger and real parking path.

Usage (see ops/live-402-proof.sh):
    python3 ops/mock-402-upstream.py --port 59999 --state /tmp/mock402.state
"""
import argparse
import hashlib
import json
import pathlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = pathlib.Path("/tmp/mock402.state")


def token_of(headers):
    auth = headers.get("Authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else ""


def hash8(tok):
    return hashlib.sha256(tok.encode()).hexdigest()[:8]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # keep the log ours
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": "glm-5.3-flash", "object": "model"}]})
        else:
            self._json(404, {"error": {"code": "NOT_FOUND", "message": "no route"}})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        _ = self.rfile.read(n)
        tok = token_of(self.headers)
        first = STATE.read_text().strip() if STATE.exists() else ""
        if not first and tok:
            STATE.write_text(tok)
            first = tok
        if tok and tok == first:
            print(f"402  token={hash8(tok)}  (the planted spent account)", flush=True)
            self._json(402, {"error": {"code": "INSUFFICIENT_CREDITS", "message": "Insufficient balance"}})
            return
        print(f"200  token={hash8(tok)}  (sibling account served it)", flush=True)
        self._json(200, {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "created": 0,
            "model": "glm-5.3-flash",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6},
        })


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=59999)
    ap.add_argument("--state", default="/tmp/mock402.state")
    a = ap.parse_args()
    STATE = pathlib.Path(a.state)
    print(f"mock 402 upstream on 127.0.0.1:{a.port} (state {STATE})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
