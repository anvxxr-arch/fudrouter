// Usage: node --env-file=apps/web/.env scripts/import-grok-pool.mjs [options]
//
//   --dir DIR      credential directory to harvest (repeatable).
//                  Defaults to the grok-register farm's cpa_auths.
//   --dry-run      report what would change; write nothing.
//   --no-check     skip the refresh health-check (imports on trust).
//   --workers N    parallel refresh checks (default 8).
//
// Merges grok OAuth credentials into the fudrouter provider pool.
//
// Two properties matter, and both were learned the hard way:
//
//  1. HEALTH-CHECK BY REFRESHING. A credential file only proves the account
//     existed when it was written. xAI revokes refresh tokens, and a pool
//     polluted with revoked accounts makes every request walk past them. Each
//     candidate is exchanged once and dropped if the exchange fails.
//
//  2. PERSIST THE ROTATION. xAI returns a NEW refresh token on every exchange,
//     and the old one stops working once the new one is used. A health check
//     that discards the response therefore DESTROYS the account. Everything
//     rotated here is written back into credentials_enc.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROVIDER = process.env.XAI_PROVIDER_NAME || 'xai-grok';
const BASE_URL = process.env.XAI_BASE_URL || 'https://cli-chat-proxy.grok.com/v1';
const CLI_VERSION = process.env.XAI_CLI_VERSION || '0.1.202';
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
const dirs = [];
let dryRun = false,
	check = true,
	workers = 8;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--dir') dirs.push(argv[++i]);
	else if (a === '--dry-run') dryRun = true;
	else if (a === '--no-check') check = false;
	else if (a === '--workers') workers = Number(argv[++i]) || 8;
	else {
		console.error(`unknown argument: ${a}`);
		process.exit(2);
	}
}
if (!dirs.length) dirs.push('/home/dwizzy/grok-register/cpa_auths');

// ---- crypto -----------------------------------------------------------------
function key() {
	const k = Buffer.from(MASTER, 'base64');
	if (k.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	return k;
}
function decrypt(wire) {
	const raw = Buffer.from(wire, 'base64');
	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(raw.length - 16);
	const ct = raw.subarray(12, raw.length - 16);
	const d = createDecipheriv('aes-256-gcm', key(), iv);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function encrypt(plain) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

// ---- refresh ----------------------------------------------------------------
async function refresh(rt) {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: rt,
		client_id: CLIENT_ID
	});
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

// ---- harvest -----------------------------------------------------------------
function harvest(d) {
	if (!existsSync(d)) {
		console.error(`  ! skipped (missing): ${d}`);
		return [];
	}
	if (!statSync(d).isDirectory()) {
		console.error(`  ! skipped (not a directory): ${d}`);
		return [];
	}
	const out = [];
	for (const f of readdirSync(d)) {
		if (!f.endsWith('.json')) continue;
		let cred;
		try {
			cred = JSON.parse(readFileSync(join(d, f), 'utf8'));
		} catch {
			continue;
		}
		if (!cred.email || !cred.refresh_token) continue;
		out.push({
			email: cred.email,
			access_token: cred.access_token || '',
			refresh_token: cred.refresh_token,
			id_token: cred.id_token || '',
			expired: cred.expired || '',
			_src: join(d, f)
		});
	}
	return out;
}

const sql = postgres(DSN);
try {
	const rows = await sql`
		select id, credentials_enc from provider where name = ${PROVIDER}`;
	if (!rows.length) {
		console.error(`provider not found: ${PROVIDER} — onboard it first`);
		process.exit(1);
	}
	const providerID = rows[0].id;
	const existing = JSON.parse(decrypt(rows[0].credentials_enc));
	const headers = existing.default_headers || { 'x-grok-client-version': CLI_VERSION };

	// Merge by email, keeping EVERY distinct token for an email, later `expired`
	// first. The DB blob and the farm's files can hold different refresh tokens
	// for the same account, and the later one is NOT always the live one: keeping
	// only the newest let a dead copy hide a token that still refreshes, and the
	// account was dropped while its file copy was fine. Seen on 2026-09-26 — 362
	// DB entries with dead rotations vs 1028 files of which 663 were live.
	const byEmail = new Map();
	const push = (a) => {
		const cur = byEmail.get(a.email) || [];
		if (cur.some((x) => x.refresh_token === a.refresh_token)) return;
		cur.push(a);
		cur.sort((x, y) => String(y.expired || '').localeCompare(String(x.expired || '')));
		byEmail.set(a.email, cur);
	};
	for (const a of existing.accounts || []) push(a);
	const before = byEmail.size;

	let added = 0;
	for (const d of dirs) {
		const found = harvest(d);
		console.log(`harvest ${d}: ${found.length} credential(s)`);
		for (const a of found) {
			if (!byEmail.has(a.email)) added++;
			push(a);
		}
	}
	let tokenCount = 0;
	for (const v of byEmail.values()) tokenCount += v.length;
	console.log(
		`\npool: ${before} existing -> ${byEmail.size} after merge (+${added} new, ${byEmail.size - before} from disk); ${tokenCount} token candidate(s) for ${byEmail.size} email(s)`
	);

	const emails = [...byEmail.entries()];
	let candidates = [...byEmail.values()].flat();
	if (dryRun) {
		// A dry run must NOT health-check: the check IS a token rotation, and
		// rotating without persisting is what killed three accounts earlier.
		// Report the merge and stop.
		console.log(
			`\n[dry-run] ${candidates.length} account(s) would be health-checked and merged; nothing rotated, nothing written`
		);
		const withExpiry = candidates.filter((a) => Number.isFinite(Date.parse(a.expired))).length;
		console.log(
			`[dry-run] ${withExpiry} carry an expiry field; the rest will be refreshed on first use`
		);
	} else if (!check) {
		console.log('--no-check: importing on trust (no health check, no rotation)');
	} else {
		console.log(`health-checking ${emails.length} account(s) with ${workers} workers...`);
		const kept = [];
		const dropped = [];
		let idx = 0;
		async function worker() {
			while (idx < emails.length) {
				const [email, cands] = emails[idx++];
				// Every distinct token for this email, newest first. A refusal is not
				// final until the older copies have had their turn too.
				let lastError = 'no candidates';
				for (const a of cands) {
					const r = await refresh(a.refresh_token);
					if (!r.ok) {
						lastError = r.error;
						continue;
					}
					kept.push({
						email,
						access_token: r.access_token,
						refresh_token: r.refresh_token,
						id_token: a.id_token || '',
						expired: new Date(Date.now() + r.expires_in * 1000)
							.toISOString()
							.replace(/\.\d+Z$/, 'Z')
					});
					lastError = null;
					break;
				}
				if (lastError) dropped.push({ email, error: lastError });
			}
		}
		await Promise.all(Array.from({ length: Math.min(workers, emails.length) }, worker));

		console.log(`\nlive: ${kept.length}   revoked/dead: ${dropped.length}`);
		const reasons = new Map();
		for (const d of dropped) {
			const k = String(d.error).replace(/\d+/g, 'N').slice(0, 60);
			reasons.set(k, (reasons.get(k) || 0) + 1);
		}
		for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]))
			console.log(`   ${String(n).padStart(4)}x ${k}`);

		if (!kept.length) {
			console.error('\nno live accounts — refusing to overwrite the pool with an empty one');
			process.exit(1);
		}
		candidates = kept.sort((a, b) => a.email.localeCompare(b.email));
	}

	candidates.sort((a, b) => a.email.localeCompare(b.email));
	const blob = {
		api_key: candidates[0].access_token,
		auth_kind: 'oauth',
		default_headers: headers,
		accounts: candidates
	};

	if (dryRun) {
		console.log(`\n[dry-run] would write ${candidates.length} account(s); nothing changed`);
	} else {
		await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(blob))} where id = ${providerID}`;
		const verify = await sql`select credentials_enc from provider where id = ${providerID}`;
		const back = JSON.parse(decrypt(verify[0].credentials_enc));
		console.log(
			`\nwrote ${back.accounts.length} account(s) to provider ${PROVIDER} (verified by re-reading)`
		);
	}
} finally {
	await sql.end();
}
