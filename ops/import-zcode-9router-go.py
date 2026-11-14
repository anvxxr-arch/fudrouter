#!/usr/bin/env python3
"""Import zcode device-flow accounts (accounts.jsonl) -> 9router-go.

Turns each linked Z.ai ZCode account into a `zcode` / authType=oauth
connection on the 9router-go dashboard API (127.0.0.1:20130, x-9r-cli-token).

accounts.jsonl schema (written by the zcode-bridge):
  {"providerSpecificData":{"zcodeJwtToken":<plan JWT>,"userId":<uuid>,
    "businessAccessToken":<jwt>,"deviceId":<uuid>,"sessionSeed":<uuid>},
   "user":{"email":...}, ...}

The plan JWT is stored as data.apiKey (the executor's bearer), accountUUID =
userId, and a stable deviceId/sessionSeed per account is kept under
<state>/zcode-identities.json so a re-login does not mint a new identity.

Usage: import-zcode-9router-go.py [--accounts PATH] [--execute]
"""
import json, hashlib, uuid, pathlib, sys, urllib.request, urllib.error

BASE = "http://127.0.0.1:20130"
DD = pathlib.Path("/home/dwizzy/.9router-go")
STATE = DD / "zcode-identities.json"
ACCOUNTS = pathlib.Path("/home/dwizzy/fudrouter/ops/zcode-bridge/accounts.jsonl")
EXECUTE = "--execute" in sys.argv
if "--accounts" in sys.argv:
    ACCOUNTS = pathlib.Path(sys.argv[sys.argv.index("--accounts") + 1])


def cli_token():
    mid = (DD / "machine-id").read_text().strip()
    sec = (DD / "auth" / "cli-secret").read_text().strip()
    return hashlib.sha256((mid + "9r-cli-auth" + sec).encode()).hexdigest()[:16]


TOK = cli_token()


def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    r.add_header("x-9r-cli-token", TOK)
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            return x.status, x.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)


def load_accounts():
    out = []
    if not ACCOUNTS.exists():
        return out
    seen = set()
    for line in ACCOUNTS.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        psd = d.get("providerSpecificData") or {}
        jwt = psd.get("zcodeJwtToken") or d.get("zcodeJwtToken")
        uid = psd.get("userId") or d.get("userId")
        email = (d.get("user") or {}).get("email") or ""
        if not jwt:
            continue
        key = uid or email
        if key in seen:
            continue
        seen.add(key)
        out.append({"jwt": jwt, "uid": uid, "email": email,
                    "business": psd.get("businessAccessToken", "")})
    return out


def main():
    accts = load_accounts()
    ident = json.loads(STATE.read_text()) if STATE.exists() else {}
    st, body = api("GET", "/api/connections")
    existing = {}
    if st == 200:
        try:
            for c in json.loads(body):
                if c.get("provider") == "zcode":
                    d = c.get("data") or {}
                    existing[c.get("name", "")] = c.get("id")
        except Exception:
            pass
    print(f"[state] accounts.jsonl={len(accts)} zcode_conns={len(existing)}")

    plan = []
    for a in accts:
        key = a["uid"] or a["email"]
        ident.setdefault(key, {"deviceId": str(uuid.uuid4()),
                               "sessionSeed": str(uuid.uuid4())})
        name = f"ZCode {a['email']}" if a["email"] else f"ZCode {key[:8]}"
        plan.append((name, {
            "provider": "zcode", "authType": "oauth", "name": name,
            "apiKey": a["jwt"], "priority": 10, "replace": True,
            "providerSpecificData": {
                "authMethod": "device", "accountUUID": a["uid"],
                "deviceId": ident[key]["deviceId"],
                "sessionSeed": ident[key]["sessionSeed"],
                "email": a["email"],
            },
        }, a["uid"]))
    print(f"[plan] {len(plan)} zcode connection(s) to upsert")
    for n, _, _ in plan:
        print("   ", n, "(exists)" if n in existing else "(new)")

    if not EXECUTE:
        print("\nDRY RUN. Re-run with --execute")
        return 0

    ok = err = 0
    for name, payload, _ in plan:
        s, b = api("POST", "/api/connections", payload)
        if s in (200, 201):
            ok += 1
            print(f"[ok] {name} -> {b[:80]}")
        else:
            err += 1
            print(f"[err] {name} -> {s} {b[:160]}")
    if ok:
        STATE.write_text(json.dumps(ident))
    print(f"\n[done] created/updated={ok} errors={err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
