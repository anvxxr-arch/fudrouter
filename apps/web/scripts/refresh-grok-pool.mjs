// Usage: node --env-file=apps/web/.env apps/web/scripts/refresh-grok-pool.mjs [options]
//
//   --provider NAME    provider whose pool to maintain (default xai-grok)
//   --within DUR       refresh accounts whose access token expires within this
//                      window: 4h, 90m, 45s. 0 = every account. Default 4h.
//   --sync-files DIR   write each rotated credential back to DIR/xai-<email>.json
//                      so the farm's copy tracks the pool instead of rotting.
//   --workers N        parallel refreshes (default 8)
//   --dry-run          report, write nothing
//   --quiet            one JSON summary line, for the timer's journal
//
// WHY THIS EXISTS. The router only refreshes the accounts it happens to serve,
// and xAI access tokens live 6h. An account that is never picked therefore rots
// on its own, and an untouched pool silently becomes a set of dead tokens —
// measured 2026-09-26: the live pool read as "no usable upstream credential"
// for 362 accounts while 663 file copies refreshed fine. Freshness must not
// depend on traffic, so this job walks the whole pool inside the expiry window
// and persists every rotation. It runs from grok-pool-refresh.timer.
//
// TWO WRITERS, ONE COLUMN. This job and the router both rewrite
// provider.credentials_enc, which is only safe because both sides merge by email
// (later `expired` wins) instead of overwriting the blob: see mergeAccounts in
// services/router/internal/proxy/pool.go, and the TTL reload in poolFor that
// makes the router pick this job's rotations up without a restart.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROVIDER = 'xai-grok';
const CLIENT_ID = process.env.XAI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
const TOKEN_ENDPOINT = process.env.XAI_TOKEN_ENDPOINT || 'https://auth.x.ai/oauth2/token';

const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;
if (!MASTER) {
	console.error('missing env: CREDENTIALS_MASTER_KEY');
	process.exit(1);
}
if (!DSN) {
	console.error('missing env: DATABASE_URL');
	process.exit(1);
}

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let provider = PROVIDER,
	within = 4 * 3600 * 1000,
	syncDir = '',
	workers = 8,
	dryRun = false,
	quiet = false;
function duration(s) {
	const m = /^(\d+)(s|m|h)?$/.exec(s);
	if (!m) throw new Error(`bad duration: ${s}`);
	const n = Number(m[1]);
	return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60000 : m[2] === 'h' ? 3600000 : m[2] === undefined ? 1000 : 0);
}
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--provider') provider = argv[++i];
	else if (a === '--within') within = duration(argv[++i]);
	else if (a === '--sync-files') syncDir = argv[++i];
	else if (a === '--workers') workers = Number(argv[++i]) || 8;
	else if (a === '--dry-run') dryRun = true;
	else if (a === '--quiet') quiet = true;
	else {
		console.error(`unknown argument: ${a}`);
		process.exit(2);
	}
}
if (!Number.isFinite(within) || within < 0) {
	console.error('--within must be a duration (4h, 90m, 45s) or 0');
	process.exit(2);
}

// ---- crypto -----------------------------------------------------------------
function key() {
	const k = Buffer.from(MASTER, 'base64');
	if (k.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	return k;
}
function decrypt(wire) {
	const raw = Buffer.from(wire, 'base64');
	const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}
function encrypt(plain) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

// ---- refresh ----------------------------------------------------------------
async function refresh(rt) {
	if (!rt) return { ok: false, error: 'no refresh token' };
	const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT_ID });
	let res;
	try {
		res = await fetch(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body
		});
	} catch (err) {
		return { ok: false, error: `network: ${err.message}` };
	}
	const text = await res.text();
	if (!res.ok) {
		let why = text.slice(0, 120);
		try {
			const j = JSON.parse(text);
			why = j.error_description || j.error || why;
		} catch {}
		return { ok: false, error: `HTTP ${res.status}: ${why}` };
	}
	let j;
	try {
		j = JSON.parse(text);
	} catch {
		return { ok: false, error: 'unparseable token response' };
	}
	if (!j.access_token) return { ok: false, error: 'no access_token in response' };
	return {
		ok: true,
		access_token: j.access_token,
		refresh_token: j.refresh_token || rt,
		expires_in: j.expires_in || 21600
	};
}

// A refusal that will never change: the account is gone, not unlucky. Anything
// else (network, 5xx, rate limit) is kept — dropping accounts because upstream
// hiccuped is how a pool shrinks for no reason.
const TERMINAL = /invalid_grant|invalid or unknown refresh token|blocked|unauthorized|HTTP 40[013]/i;

function parseExpiry(s) {
	const t = Date.parse(s || '');
	return Number.isNaN(t) ? null : t;
}

// Same rule as mergeAccounts in the Go pool: the copy whose access token expires
// later is the one that rotated more recently, so it wins.
function expiryAtLeast(a, b) {
	if (!b) return true;
	if (!a) return false;
	const ta = parseExpiry(a),
		tb = parseExpiry(b);
	if (ta !== null && tb !== null) return ta >= tb;
	return a >= b;
}

// ---- run --------------------------------------------------------------------
const sql = postgres(DSN, { max: 1, idle_timeout: 20 });
// Resolve by id OR name: provider ids have been re-seeded (xai-grok is now a
// generated uuid), and a maintenance job that only knows the old slug would
// silently find no provider and report the pool clean.
const [row] = await sql`select id, credentials_enc from provider
	where id = ${provider} or name = ${provider}
	order by (id = ${provider}) desc limit 1`;
if (!row) {
	console.error(`provider ${provider} not found`);
	await sql.end();
	process.exit(1);
}
const cred = JSON.parse(decrypt(row.credentials_enc));
const accounts = Array.isArray(cred.accounts) ? cred.accounts : [];

const now = Date.now();
const targets = accounts.filter((a) => {
	const exp = parseExpiry(a.expired);
	return within === 0 || exp === null || exp - now <= within;
});

const refreshed = new Map();
const dropped = [];
const kept = [];
let cursor = 0;
async function work() {
	while (cursor < targets.length) {
		const a = targets[cursor++];
		// A dry run must not exchange anything. xAI rotates the refresh token on
		// every exchange, so a "check" whose result is thrown away leaves the
		// account's stored chain behind the one xAI now expects — deliberately
		// offline: report the window, touch nothing.
		if (dryRun) {
			kept.push({ email: a.email, error: 'dry-run' });
			continue;
		}
		const r = await refresh(a.refresh_token);
		if (r.ok) {
			const exp = new Date(Date.now() + (r.expires_in || 21600) * 1000)
				.toISOString()
				.replace(/\.\d{3}Z$/, 'Z');
			refreshed.set(a.email, {
				...a,
				access_token: r.access_token,
				refresh_token: r.refresh_token,
				expires_in: r.expires_in || 21600,
				expired: exp,
				last_refresh: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
			});
		} else if (TERMINAL.test(r.error)) {
			dropped.push({ email: a.email, error: r.error });
		} else {
			kept.push({ email: a.email, error: r.error });
		}
	}
}
await Promise.all(Array.from({ length: Math.max(1, workers) }, work));

// Rebuild in the original order, with rotations applied and dead accounts gone.
const dropSet = new Set(dropped.map((d) => d.email));
const next = [];
for (const a of accounts) {
	if (dropSet.has(a.email)) continue;
	next.push(refreshed.get(a.email) || a);
}
let written = 0;
let created = 0;
// Another writer (the router) persists rotations for the same accounts while
// this job runs. Merge into the blob as it is NOW instead of overwriting it with
// the snapshot read before the refreshes: the freshest chain per email survives,
// and accounts neither side has seen are kept.
let final = next;
if (!dryRun && (refreshed.size > 0 || dropped.length > 0)) {
	const [fresh] = await sql`select credentials_enc from provider where id = ${row.id}`;
	const prior = JSON.parse(decrypt(fresh.credentials_enc)).accounts || [];
	const ours = new Map(next.map((a) => [a.email, a]));
	final = [];
	for (const a of prior) {
		if (dropSet.has(a.email)) continue;
		const mine = ours.get(a.email);
		if (!mine) {
			final.push(a);
			continue;
		}
		final.push(expiryAtLeast(mine.expired, a.expired) ? mine : a);
		ours.delete(a.email);
	}
	for (const a of ours.values()) final.push(a);
	if (accounts.length > 0 && final.length === 0) {
		console.error('refusing to persist an empty pool — every account was refused in one run');
		await sql.end();
		process.exit(1);
	}
	const payload = { ...cred, accounts: final };
	// row.id, not the --provider argument: the argument may be a NAME, and an
	// UPDATE that matches nothing succeeds silently — the rotations then live
	// only in the farm files while the database keeps the chain they rotated
	// away from. Assert the write landed.
	const res = await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(payload))} where id = ${row.id}`;
	if (res.count !== 1) {
		console.error(`persist matched ${res.count} provider rows (expected 1) — aborting`);
		await sql.end();
		process.exit(1);
	}
}
if (!dryRun) {
	if (syncDir) {
		for (const a of refreshed.values()) {
			const f = join(syncDir, `xai-${a.email}.json`);
			// Merge into the file's own shape: the farm writes keys (id_token,
			// redirect_uri, sub…) this script never touches, and dropping them
			// would make the file useless to the tool that produced it.
			let prior = {};
			const existed = existsSync(f);
			if (existed) {
				try {
					prior = JSON.parse(readFileSync(f, 'utf8'));
				} catch {}
			}
			writeFileSync(f, JSON.stringify({ ...prior, ...a }, null, 2) + '\n', { mode: 0o600 });
			written++;
			if (!existed) created++;
		}
	}
}

const summary = {
	provider,
	at: new Date().toISOString(),
	pool: final.length,
	checked: targets.length,
	refreshed: refreshed.size,
	dropped: dropped.length,
	kept: kept.length,
	dryRun,
	files: syncDir ? { written, created } : undefined
};
if (quiet) {
	console.log(JSON.stringify(summary));
} else {
	console.log(
		`provider ${provider}: pool=${final.length} checked=${targets.length} refreshed=${refreshed.size} dropped=${dropped.length} kept=${kept.length}${dryRun ? ' (dry-run)' : ''}`
	);
	if (syncDir) console.log(`  files: ${written} written (${created} created) in ${syncDir}`);
	for (const d of dropped.slice(0, 10)) console.log(`  dropped ${d.email}: ${d.error}`);
	if (dropped.length > 10) console.log(`  ... and ${dropped.length - 10} more dropped`);
	for (const k of kept.slice(0, 10)) console.log(`  kept ${k.email}: ${k.error}`);
	if (kept.length > 10) console.log(`  ... and ${kept.length - 10} more kept`);
}
await sql.end();
