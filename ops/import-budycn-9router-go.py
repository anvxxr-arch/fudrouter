#!/usr/bin/env python3
"""Import budycn (CodeBuddy.cn) accounts -> 9router-go.

Turns each OAuth token captured by budycn into a `codebuddy-cn` / authType=oauth
connection on the 9router-go dashboard API (127.0.0.1:20130, x-9r-cli-token).

Why not write SQLite directly (what budycn's src/db/inject.py does)?
  * budycn's config.toml points at ~/.9router/db/data.sqlite, but the live
    gateway reads ~/.9router-go/db/data.sqlite -> tokens land as orphans.
  * The live gateway envelope-seals credentials (secretCiphertext /
    tokenCiphertext + wrapped DEK). A plaintext INSERT bypasses the vault and
    only gets migrated on the next boot scan.
Going through POST /api/connections writes the row, seals it, and clears stale
model locks in one step.

Input: budycn's data/oauth_tokens.json (a JSON array of objects with the keys
  phone, state, accessToken, refreshToken, expiresIn).

Usage:
  import-budycn-9router-go.py [--tokens PATH] [--prio N] [--execute]

Dry run by default; pass --execute to actually write.
"""
import hashlib, json, pathlib, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:20130"
DD = pathlib.Path("/home/dwizzy/.9router-go")
DEFAULT_TOKENS = pathlib.Path("/home/dwizzy/.hermes/cache/scratch/budycn/data/oauth_tokens.json")
PROVIDER = "codebuddy-cn"

EXECUTE = "--execute" in sys.argv
TOKENS = DEFAULT_TOKENS
if "--tokens" in sys.argv:
    TOKENS = pathlib.Path(sys.argv[sys.argv.index("--tokens") + 1])
PRIO = 10
if "--prio" in sys.argv:
    PRIO = int(sys.argv[sys.argv.index("--prio") + 1])


def cli_token():
    """Derive the local CLI token the dashboard guard accepts."""
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


def load_tokens():
    """Read budycn's token file -> normalized account dicts."""
    out = []
    if not TOKENS.exists():
        return out
    try:
        raw = json.loads(TOKENS.read_text())
    except json.JSONDecodeError:
        return out
    if not isinstance(raw, list):
        raw = [raw]
    seen = set()
    for d in raw:
        if not isinstance(d, dict):
            continue
        at = d.get("accessToken")
        if not at:
            continue
        key = d.get("phone") or at[:24]
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "phone": d.get("phone") or "",
            "accessToken": at,
            "refreshToken": d.get("refreshToken") or "",
            "expiresIn": d.get("expiresIn") or 86400,
        })
    return out


def existing_connections():
    st, body = api("GET", "/api/connections")
    names, ids = set(), {}
    if st == 200:
        try:
            for c in json.loads(body):
                if c.get("provider") == PROVIDER:
                    names.add(c.get("name", ""))
                    ids[c.get("name", "")] = c.get("id")
        except Exception:
            pass
    return names, ids


def main():
    accts = load_tokens()
    names, ids = existing_connections()
    print(f"[state] tokens={TOKENS} accounts={len(accts)} existing {PROVIDER} conns={len(names)}")

    plan = []
    for a in accts:
        phone = a["phone"]
        name = f"CodeBuddy CN {phone}" if phone else f"CodeBuddy CN {a['accessToken'][:8]}"
        expires_at = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + a["expiresIn"])
        )
        payload = {
            "provider": PROVIDER,
            "authType": "oauth",
            "name": name,
            "apiKey": a["accessToken"],
            "priority": PRIO,
            "replace": True,
            # data carries the refresh material the background refresher reads:
            # accessToken/refreshToken/expiresAt (RFC3339) are the three fields
            # SelectConnectionsNeedingRefresh parses.
            "data": {
                "accessToken": a["accessToken"],
                "refreshToken": a["refreshToken"],
                "expiresAt": expires_at,
                "tokenType": "Bearer",
            },
            "providerSpecificData": {
                "authMethod": "device",
                "phone": phone,
                "domain": "copilot.tencent.com",
            },
        }
        plan.append((name, payload))

    for n, _ in plan:
        print("   ", n, "(update)" if n in names else "(new)")

    if not EXECUTE:
        print("\nDRY RUN. Re-run with --execute")
        return 0

    ok = err = 0
    for name, payload in plan:
        s, b = api("POST", "/api/connections", payload)
        if s in (200, 201):
            ok += 1
            print(f"[ok] {name} -> {b[:100]}")
        else:
            err += 1
            print(f"[err] {name} -> {s} {b[:200]}")
    print(f"\n[done] created/updated={ok} errors={err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
