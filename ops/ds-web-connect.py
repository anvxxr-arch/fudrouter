#!/usr/bin/env python3
"""Register / refresh a DeepSeek Web credential on the 9router-go gateway (:20130).

The lane "deepseek-web" (alias "ds-web") is not an API-key provider: it drives
chat.deepseek.com's own web API with a browser session. Two parts are needed:

  * userToken  -- chat.deepseek.com -> DevTools -> Application -> Local Storage -> userToken
                  (stored as the connection's apiKey)
  * cookie     -- the WHOLE cookie header of a signed-in tab
                  (DevTools -> Network -> any /api/v0 request -> Cookie)
                  (stored as providerSpecificData.deepSeekCookie; the WAF reads it)

Usage:
  ./ds-web-connect.py --token <userToken> [--cookie '<cookie header>' | --cookie-file f]
                      [--name ds-main-1] [--chat] [--renew] [--key sk-...]

Exit codes: 0 valid, 1 upstream rejected the credential, 2 usage/API error.
"""
from __future__ import annotations

from typing import Any

import argparse
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

HOME = pathlib.Path.home()
STATE = HOME / ".9router-go"
DEFAULT_GATEWAY = "http://127.0.0.1:20130"
PROVIDER = "deepseek-web"
DEFAULT_MODEL = "ds-web/deepseek-v4-flash"


def cli_token() -> str:
    raw = (STATE / "machine-id").read_text().strip()
    secret = (STATE / "auth" / "cli-secret").read_text().strip()
    return hashlib.sha256(f"{raw}9r-cli-auth{secret}".encode()).hexdigest()[:16]


def call(base: str, method: str, path: str, body=None, headers=None, timeout=120):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read().decode()
            return r.status, (json.loads(payload) if payload.strip() else {})
    except urllib.error.HTTPError as e:
        payload = e.read().decode()
        try:
            return e.code, json.loads(payload)
        except json.JSONDecodeError:
            return e.code, {"raw": payload}


def find_connection(base, admin, name):
    _, listing = call(base, "GET", "/api/connections", headers=admin)
    rows = listing if isinstance(listing, list) else listing.get("connections", [])
    for c in rows:
        if c.get("provider") == PROVIDER and c.get("name") == name:
            return c
    return None


def ensure_gateway_key(base, admin, key, model):
    """Return (key, created) with `model` allowed on it."""
    if key:
        _, keys = call(base, "GET", "/api/keys", headers=admin)
        row = next((k for k in (keys if isinstance(keys, list) else keys.get("keys", []))
                    if k.get("key") == key), None)
        if row is None:
            raise SystemExit(f"gateway key {key} not found on this router")
        _, acc = call(base, "GET", f"/api/keys/{row['id']}/models", headers=admin)
        allowed = list(acc.get("models") or [])
        if model not in allowed:
            allowed.append(model)
            call(base, "PUT", f"/api/keys/{row['id']}/models", {"models": allowed}, admin)
        return key, False
    _, res = call(base, "POST", "/api/keys", {"name": "ds-web-probe"}, admin)
    key = res["key"]
    call(base, "PUT", f"/api/keys/{res['id']}/models", {"models": [model]}, admin)
    return key, True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True, help="userToken from localStorage")
    ap.add_argument("--cookie", default=None, help="full cookie header")
    ap.add_argument("--cookie-file", default=None)
    ap.add_argument("--name", default="ds-main-1")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--gateway", default=os.environ.get("NINE_ROUTER", DEFAULT_GATEWAY))
    ap.add_argument("--key", default=None, help="gateway key to test with (else make one)")
    ap.add_argument("--chat", action="store_true", help="send one live completion")
    ap.add_argument("--renew", action="store_true", help="run the renew-deepseek flow first")
    ap.add_argument("--no-stealth", action="store_true",
                    help="disable browser fingerprint mode (diagnosis only — mutes accounts)")
    ap.add_argument("--delete", action="store_true", help="remove the named connection")
    args = ap.parse_args()

    base = args.gateway.rstrip("/")
    admin = {"x-9r-cli-token": cli_token()}
    cookie = args.cookie
    if args.cookie_file:
        cookie = pathlib.Path(args.cookie_file).read_text().strip()
    cookie = (cookie or "").strip().strip("'\"")

    existing = find_connection(base, admin, args.name)
    if args.delete:
        if not existing:
            print(f"no connection named {args.name}")
            return 0
        code, res = call(base, "DELETE", f"/api/connections/{existing['id']}", headers=admin)
        print(code, res)
        return 0 if code == 200 else 2

    payload = {
        "provider": PROVIDER,
        "authType": "cookie",
        "name": args.name,
        "priority": (existing or {}).get("priority", 1) or 1,
        "apiKey": args.token.strip(),
        "providerSpecificData": {
            "deepSeekCookie": cookie,
            "stealth": not args.no_stealth,
        },
    }
    if args.renew and cookie == "":
        payload["providerSpecificData"]["renew"] = True

    if existing:
        code, res = call(base, "PUT", f"/api/connections/{existing['id']}", payload, admin)
        cid = existing["id"]
        action = "updated"
    else:
        code, res = call(base, "POST", "/api/connections", payload, admin)
        cid = res.get("id", "")
        action = "created"
    print(f"{action}: {code} {res}")
    if code not in (200, 201) or not cid:
        return 2

    if args.renew:
        code, res = call(base, "POST", f"/api/connections/{cid}/renew-deepseek", {}, admin)
        print(f"renew: {code} {res}")

    code, res = call(base, "POST", f"/api/connections/{cid}/test", {}, admin)
    valid = bool(res.get("valid"))
    print(f"test: {code} valid={valid} {res}")
    if not valid:
        return 1

    if args.chat:
        key, made = ensure_gateway_key(base, admin, args.key, args.model)
        body = {"model": args.model, "messages": [{"role": "user", "content": "Say OK"}],
                "max_tokens": 16, "stream": False}
        code, res = call(base, "POST", "/v1/chat/completions", body,
                         {"authorization": f"Bearer {key}"})
        text = ""
        if isinstance(res, dict) and res.get("choices"):
            text = res["choices"][0].get("message", {}).get("content", "")
        print(f"chat: {code} key={key}{' (new)' if made else ''} -> {text!r}")
        if code != 200:
            print(json.dumps(res)[:500])
            return 2
    print(f"connection id: {cid}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
