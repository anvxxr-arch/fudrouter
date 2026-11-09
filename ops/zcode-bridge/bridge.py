#!/usr/bin/env python3
"""zcode-bridge — Relay Z.ai (GLM) farm's 9router calls straight to zcode.z.ai.

The farm (zai_farm.py) was written against a 9router/xrouter control plane:
  POST /api/auth/login                      -> no-op (farm just warms the cookie jar)
  GET  /api/oauth/glm/device-code           -> device code + _zcodePollToken/_zcodeFamily
  POST /api/oauth/glm/poll                  -> poll until linked; then connection object
  GET  /api/raw?email=<addr>                -> read activation link from tempmail worker
That control plane does not exist on this server, so this bridge emulates the
exact endpoints and relays to the real ZCode CLI OAuth endpoints:
  POST https://zcode.z.ai/api/v1/oauth/cli/init   {provider:zai}  Bearer <poll_token>
  GET  https://zcode.z.ai/api/v1/oauth/cli/poll/{flow_id}         Bearer <poll_token>
When a link succeeds it writes the artifact row to ACCOUNTS_FILE as JSON lines:
  {"conn_id":"...","providerSpecificData":{"zcodeJwtToken":"...","userId":"..."},...}
which zcode-bridge/import.mjs reads to onboard the provider into fudrouter.

Mail: on boot we read MAIL_API_URL/MAIL_API_KEY (the existing own-domain read path,
see farm-mail-verification skill) and expose the farm's expected contract
  GET /api/raw?email=<addr> -> {"raw": "...", "html": "...", "found": bool}
backed by the estate mail worker's `?key=...&to=<addr>` endpoint.

Stateless by design: no DB, single file append (accounts.jsonl), survives restart.
"""
import json
import os
import secrets
import time
import urllib.parse
import urllib.request
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRIDGE_PORT = int(os.environ.get("ZCODE_BRIDGE_PORT", "8907"))
ZCODE_BASE = "https://zcode.z.ai/api/v1/oauth"
CLIENT_VERSION = "3.16.3"  # start-plan gateway only admits this fingerprint
USER_AGENT = f"ZCode/{CLIENT_VERSION} (Windows NT 10.0; Win64; x64)"
FAMILY = "zai"
CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg"
THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS_FILE = os.environ.get("ZCODE_ACCOUNTS_FILE", os.path.join(THIS_DIR, "accounts.jsonl"))
STATE_FILE = os.environ.get("ZCODE_STATE_FILE", os.path.join(THIS_DIR, "accounts_state.json"))

# Mail read path (own-domain estate worker; see farm-mail-verification skill)
MAIL_API_URL = os.environ.get("MAIL_API_URL", "").rstrip("/")
MAIL_API_KEY = os.environ.get("MAIL_API_KEY", "")

# One in-flight poll token per device code (flow). The farm polls with the
# same device_code; we keep the flow_id -> poll_token mapping so the relay can
# present the poll token to cli/poll. TTL'd at 1800s (signup can take >5min).
_flows = {}


class BridgeError(Exception):
    pass


def _post(url, payload=None, headers=None, timeout=30):
    data = json.dumps(payload).encode() if payload is not None else b""
    h = {"Content-Type": "application/json", "User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST" if payload is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def _zcode_init():
    poll_token = secrets.token_hex(32)
    st, data = _post(f"{ZCODE_BASE}/cli/init", {"provider": FAMILY},
                     headers={"Authorization": f"Bearer {poll_token}"})
    d = data.get("data") or data
    flow_id = d.get("flow_id")
    if not flow_id:
        raise BridgeError(f"cli/init no flow_id: {data}")
    _flows[flow_id] = {"poll_token": poll_token, "ts": time.time()}
    authorize_url = d.get("authorize_url")
    return {
        "device_code": flow_id,              # farm treats this as the device code
        "verification_uri": authorize_url,
        "_zcodePollToken": poll_token,
        "_zcodeFamily": FAMILY,
        "user_code": d.get("user_code") or d.get("userCode") or "",
        "expires_at": d.get("expires_at"),
        "poll_interval_sec": d.get("poll_interval_sec", 2),
    }


def _zcode_poll(flow_id):
    fl = _flows.get(flow_id)
    if not fl:
        raise BridgeError("unknown flow")
    st, data = _post(f"{ZCODE_BASE}/cli/poll/{flow_id}",
                     headers={"Authorization": f"Bearer {fl['poll_token']}"})
    d = data.get("data") or data
    status = d.get("status")
    if status == "ready":
        token = d.get("token")  # zcode JWT
        zai = d.get("zai") or {}
        user = d.get("user") or {}
        conn = {
            "id": "conn_zai_" + uuid.uuid4().hex[:12],
            "provider": "zcode",
            "providerSpecificData": {
                "zcodeJwtToken": token,
                "userId": user.get("user_id") or "",
                "businessAccessToken": zai.get("access_token") or "",
            },
            "user": user,
            "linkedAt": time.time(),
            "flow_id": flow_id,
        }
        with open(ACCOUNTS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(conn, ensure_ascii=False) + "\n")
        return {"success": True, "data": {"connection": conn}, "connection": conn}
    if status == "failed":
        return {"success": False, "msg": "auth_failed", "data": d, "connection": None}
    return {"success": False, "msg": "not_ready", "data": d, "connection": None}


def _load_accounts():
    """Read accounts.jsonl -> list of dict rows (tolerant of blank/bad lines)."""
    out = []
    if not os.path.exists(ACCOUNTS_FILE):
        return out
    try:
        with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        pass
    return out


def _load_state():
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _save_state(stateAmericas):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(stateAmericas, f, ensure_ascii=False})
    os.replace(tmp, STATE_FILE)


def _providers_list():
    """Emulate 9router GET /api/providers?provider=glm -> {connections:[...]}."""
    stateAmer = _load_state()
    conns = []
    for row in _load_accounts():
        psd = row.get("providerSpecificData") or {}
        if not (psd.get("zcodeJwtToken") or row.get("zcodeJwtToken")):
            continue
        cid = row.get("id") or row.get("conn_id")
        if not cid:
            continue
        conns.append({
            "id": cid,
            "name": row.get("email") or psd.get("email") or cid,
            "email": row.get("email") or psd.get("email") or "",
            "isActive": bool(stateAmer.get(cid, True)),
            "provider": row.get("provider") or "zcode",
            "providerSpecificData": psd,
            "linkedAt": row.get("linkedAt"),
            "flow_id": row.get("flow_id"),
        })
    return {"connections": conns, "total": len(conns)}


def _mail_read(email):
    """Return {raw, html, found} for a verification mail at <email>.

    Farm contract: GET /api/raw?email=<addr> -> {"raw":..., "html":..., "found":...}
    Backed by estate worker GET <MAIL_API_URL>?key=...&to=<addr> -> {"messages":[...]}.
    """
    if not MAIL_API_URL:
        return {"raw": "", "html": "", "found": False, "error": "mail_unconfigured"}
    q = urllib.parse.urlencode({"key": MAIL_API_KEY, "to": email})
    target = f"{MAIL_API_URL}/?{q}"
    try:
        req = urllib.request.Request(target, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode() or "{}")
        msgs = data.get("messages") or data.get("data") or data.get("raw") or []
        if isinstance(msgs, list):
            text = "\n".join(str(m) for m in msgs)
        else:
            text = str(msgs)
        found = bool(data.get("count")) if isinstance(data.get("count"), int) else bool(msgs)
        return {"raw": text, "html": text, "found": found, "count": len(msgs) if isinstance(msgs, list) else 0}
    except Exception as e:
        return {"raw": "", "html": "", "found": False, "error": str(e)}


class Handler(BaseHTTPRequestHandler):
    server_version = "ZCodeBridge/1.0"

    def log_message(self, format, *args):  # noqa: A002
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode())
        except Exception:
            return {}

    def do_GET(self):
        p = self.path.split("?")[0].rstrip("/")
        if p == "/api/oauth/glm/device-code":
            try:
                self._send(_zcode_init())
            except Exception as e:
                self._send({"device_code": str(e), "verification_uri": "", "error": 1}, 502)
            return
        if p == "/api/raw":
            email = (self.path.split("?", 1)[1] if "?" in self.path else "")
            qs = urllib.parse.parse_qs(email)
            addr = (qs.get("email") or [""])[0]
            if not addr:
                self._send({"raw": "", "html": "", "found": False, "error": "email param missing"}, 400)
                return
            self._send(_mail_read(addr))
            return
        self._send({"success": True, "data": {}}, 404)

    def do_PUT(self):
        # farm: PUT /api/providers/{conn_id} {isActive:false} to disable when plan
        # not yet granted. Stateless bridge: nothing to disable, acknowledge.
        self._send({"success": True, "data": {"ok": True}})
        return

    def do_POST(self):
        body = self._json()
        p = self.path.rstrip("/")
        if p == "/api/auth/login":
            self._send({"success": True, "data": {"ok": True}})
            return
        if p == "/api/oauth/glm/poll":
            device_code = body.get("deviceCode") or body.get("device_code") or body.get("flow_id")
            if not device_code:
                self._send({"success": False, "msg": "deviceCode required"}, 400)
                return
            try:
                self._send(_zcode_poll(device_code))
            except Exception as e:
                self._send({"success": False, "msg": str(e)}, 502)
            return
        self._send({"success": False, "msg": "not_found"}, 404)


def main():
    # prune stale flows (1800s)
    cutoff = time.time() - 1800
    for k in list(_flows):
        if _flows[k]["ts"] < cutoff:
            del _flows[k]
    srv = ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), Handler)
    print(f"[zcode-bridge] 127.0.0.1:{BRIDGE_PORT} -> {ACCOUNTS_FILE}", flush=True)
    print(f"[zcode-bridge] mail: {'configured' if MAIL_API_URL else 'UNCONFIGURED'}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
