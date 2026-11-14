#!/usr/bin/env python3
"""Import fudrouter providers + credentials -> 9router-go.

Reads fudrouter Postgres, decrypts credential blobs (AES-256-GCM,
CREDENTIALS_MASTER_KEY), then POSTs the missing ones to 9router-go's
dashboard API (x-9r-cli-token). Provider nodes are created on demand.

Usage: import_fud.py [--execute] [--include-invalid]
"""
import base64, hashlib, json, pathlib, sqlite3, subprocess, sys, collections, threading, time
import urllib.request, urllib.error
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

EXECUTE = '--execute' in sys.argv
INCLUDE_INVALID = '--include-invalid' in sys.argv
BASE = 'http://127.0.0.1:20130'

FR = pathlib.Path('/home/dwizzy/fudrouter')
env = (FR/'.env').read_text()
DBURL = next(l.split('=',1)[1].strip().strip('"').strip("'") for l in env.splitlines() if l.startswith('DATABASE_URL='))
MK = base64.b64decode(next(l.split('=',1)[1].strip().strip('"').strip("'") for l in env.splitlines() if l.startswith('CREDENTIALS_MASTER_KEY=')))

def dec(enc):
    b = base64.b64decode(enc)
    return json.loads(AESGCM(MK).decrypt(b[:12], b[12:-16] + b[-16:], None).decode())

# ---- 9router-go auth (cli token) ----
DD = pathlib.Path('/home/dwizzy/.9router-go')
TOK = hashlib.sha256(((DD/'machine-id').read_text().strip()+'9r-cli-auth'+(DD/'auth'/'cli-secret').read_text().strip()).encode()).hexdigest()[:16]

def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(BASE+path, data=data, method=method)
    r.add_header('x-9r-cli-token', TOK)
    r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)

# ---- existing state ----
sq = sqlite3.connect('/home/dwizzy/.9router-go/db/data.sqlite')
have = set()
for prov, data in sq.execute("select provider,data from providerConnections"):
    try:
        k = json.loads(data).get('apiKey')
    except Exception:
        k = None
    if k:
        have.add(hashlib.sha256(k.encode()).hexdigest())
def load_nodes():
    return json.loads(api('GET', '/api/provider-nodes')[1]).get('nodes', [])
nodes = {n['id']: n for n in load_nodes()}
node_by_prefix = {}
for n in nodes.values():
    if n.get('prefix'):
        node_by_prefix.setdefault(n['prefix'], n['id'])
node_prefix = set(node_by_prefix)
print(f"[state] 9router-go keys={len(have)} nodes={len(nodes)}", file=sys.stderr)

# ---- fudrouter creds ----
SQL = ("select cr.secret_enc, cr.status, c.slug, c.base_url, coalesce(p.slug,'') "
       "from credential cr join connection c on c.id=cr.connection_id "
       "join provider p on p.id=c.provider_id")
r = subprocess.run(['psql', DBURL, '-A', '-F', '\x1f', '-t', '-P', 'pager=off', '-c', SQL],
                   capture_output=True, text=True)
groups = collections.defaultdict(list)   # (provider_slug, base_url) -> [(key, status)]
SKIP_STATUS = set() if INCLUDE_INVALID else {'invalid', 'disabled'}
seen = set()
dups = 0
for line in r.stdout.splitlines():
    if not line.strip():
        continue
    enc, status, cs, base, ps = line.split('\x1f')
    if status in SKIP_STATUS:
        continue
    try:
        blob = dec(enc)
    except Exception:
        continue
    for k in ([blob['api_key']] if blob.get('api_key') else []) + \
             [a.get('key') for a in (blob.get('accounts') or []) if isinstance(a, dict) and a.get('key')]:
        h = hashlib.sha256(k.encode()).hexdigest()
        if h in have or h in seen:
            dups += 1
            continue
        seen.add(h)
        groups[(ps or cs, base)].append((k, status))

NATIVE = {'openrouter','minimax','cline','kiro','mistral','tokenharbor','dahl','gemini',
          'sambanova','nous','freebuff','groq','deepseek','anthropic','openai'}
def norm_prov(ps, base):
    slug = ps[4:] if ps.startswith('prv-') else ps
    if slug in node_by_prefix:            # an existing/created custom node owns this prefix
        return node_by_prefix[slug], None
    if slug in NATIVE:                    # native provider, no node needed
        return slug, None
    return f"openai-compatible-chat-{slug}", slug

plan_nodes, plan_conns = {}, collections.Counter()
for (ps, base), items in groups.items():
    prov, prefix = norm_prov(ps, base)
    if prefix and prov not in nodes and prefix not in node_prefix:
        plan_nodes[prov] = prefix
        node_prefix.add(prefix)
    plan_conns[prov] += len(items)

print(f"[plan] missing keys={sum(plan_conns.values())} (dupes skipped={dups})")
print(f"[plan] nodes to create: {plan_nodes}")
for p, n in plan_conns.most_common():
    print(f"  {n:6d} -> {p}")

if not EXECUTE:
    print("\nDRY RUN. Re-run with --execute")
    sys.exit(0)

# ---- create nodes ----
for prov, prefix in plan_nodes.items():
    base = next(b for (ps, b), items in groups.items() if norm_prov(ps, b)[0] == prov)
    st, body = api('POST', '/api/provider-nodes',
                   {'name': prefix, 'prefix': prefix, 'apiType': 'chat', 'baseUrl': base,
                    'type': 'openai-compatible'})
    print(f"[node] {prov} -> {st} {body[:120]}")
# refresh prefix -> id map (created nodes get uuid ids)
nodes = {n['id']: n for n in load_nodes()}
node_by_prefix = {}
for n in nodes.values():
    if n.get('prefix'):
        node_by_prefix.setdefault(n['prefix'], n['id'])

# ---- create connections ----
lock = threading.Lock()
ok = err = 0
errs = collections.Counter()
def worker(prov, keys, slug):
    global ok, err
    for i, (k, status) in enumerate(keys):
        st, body = api('POST', '/api/connections',
                       {'provider': prov, 'authType': 'apikey', 'name': f"{slug}-imp{i+1:04d}",
                        'apiKey': k, 'priority': 10, 'allowPrivateNetworking': True})
        with lock:
            if st in (200, 201):
                ok += 1
            else:
                err += 1
                errs[f"{st}:{body[:80]}"] += 1
                print(f"[warn] {slug} {st} {body[:160]}")

for (ps, base), items in groups.items():
    prov, _ = norm_prov(ps, base)
    disp = (ps[4:] if ps.startswith('prv-') else ps) or base.split('//')[-1].split('/')[0]
    t = threading.Thread(target=worker, args=(prov, items, disp))
    t.start()
    t.join()

print(f"\n[done] created={ok} errors={err}")
for k, v in errs.most_common(10):
    print(f"  {v:5d}  {k}")
