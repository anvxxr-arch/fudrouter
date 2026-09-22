// Usage: node --env-file=apps/web/.env scripts/pool-usage.mjs [options]
//
//   --provider NAME   provider row to inspect (default xai-grok)
//   --limit N         only check the first N accounts (default: all)
//   --workers N       parallel requests (default 6)
//   --prune           drop accounts that are blocked or lack Grok Code access
//   --json            emit machine-readable output instead of a table
//
// Reports each account's upstream quota state by calling the two real
// per-account endpoints on the grok CLI proxy:
//
//   GET /v1/user     -> email, userId, userBlockedReason, hasGrokCodeAccess,
//                       team/organization + role
//   GET /v1/billing  -> config.used.val  (REAL consumption counter)
//                       config.monthlyLimit.val, config.onDemandCap.val,
//                       billingPeriodStart/End + 3 months of history
//
// WHY THIS MATTERS: a token that refreshes fine is not necessarily a usable
// account. xAI can block an account or strip Grok Code access while the OAuth
// grant keeps working, so a pool can be full of accounts that authenticate and
// then fail every request. Health-checking only the refresh token hides that.
//
// NOT USEFUL: the `x-ratelimit-*` response headers on /chat/completions
// (limit-requests=21, limit-tokens=1000000) never decrement — measured across
// repeated calls on one account. Treat them as the advertised window, not as a
// live remaining counter. `billing.used` is the counter that actually moves.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const BASE = process.env.XAI_BASE_URL || 'https://cli-chat-proxy.grok.com/v1';
const CLI_VERSION = process.env.XAI_CLI_VERSION || '0.1.202';

const argv = process.argv.slice(2);
let providerName = process.env.XAI_PROVIDER_NAME || 'xai-grok';
let limit = Infinity, workers = 6, prune = false, asJson = false;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--provider') providerName = argv[++i];
	else if (a === '--limit') limit = Number(argv[++i]) || Infinity;
	else if (a === '--workers') workers = Number(argv[++i]) || 6;
	else if (a === '--prune') prune = true;
	else if (a === '--json') asJson = true;
	else { console.error(`unknown argument: ${a}`); process.exit(2); }
}

const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const DSN = process.env.DATABASE_URL;
if (!MASTER) { console.error('missing env: CREDENTIALS_MASTER_KEY'); process.exit(1); }
if (!DSN) { console.error('missing env: DATABASE_URL'); process.exit(1); }

const key = Buffer.from(MASTER, 'base64');
function decrypt(wire) {
	const raw = Buffer.from(wire, 'base64');
	const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
}
function encrypt(plain) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key, iv);
	return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

async function get(token, path, timeoutMs = 25000) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(BASE + path, {
			headers: {
				Authorization: `Bearer ${token}`,
				'User-Agent': 'grok-cli/0.1.202',
				'x-grok-client-version': CLI_VERSION,
			},
			signal: ctl.signal,
		});
		const text = await res.text();
		let body = null;
		try { body = JSON.parse(text); } catch {}
		return { status: res.status, body, text };
	} catch (err) {
		return { status: 0, body: null, text: String(err.message || err) };
	} finally {
		clearTimeout(t);
	}
}

const sql = postgres(DSN);
try {
	const [row] = await sql`
		select id, credentials_enc from provider where name = ${providerName}`;
	if (!row) { console.error(`provider not found: ${providerName}`); process.exit(1); }

	const blob = JSON.parse(decrypt(row.credentials_enc));
	const accounts = blob.accounts || [];
	if (!accounts.length) { console.error('provider has no accounts'); process.exit(1); }

	const targets = accounts.slice(0, Number.isFinite(limit) ? limit : accounts.length);
	if (!asJson) console.log(`checking ${targets.length}/${accounts.length} account(s) on ${providerName} with ${workers} workers...\n`);

	const results = [];
	let idx = 0;
	async function worker() {
		while (idx < targets.length) {
			const a = targets[idx++];
			const [user, billing] = await Promise.all([
				get(a.access_token, '/user'),
				get(a.access_token, '/billing'),
			]);
			const cfg = billing.body?.config;
			results.push({
				email: a.email,
				httpUser: user.status,
				httpBilling: billing.status,
				blocked: user.body?.userBlockedReason ?? null,
				grokCode: user.body?.hasGrokCodeAccess ?? null,
				used: cfg?.used?.val ?? null,
				monthlyLimit: cfg?.monthlyLimit?.val ?? null,
				onDemandCap: cfg?.onDemandCap?.val ?? null,
				periodEnd: cfg?.billingPeriodEnd ?? null,
				_a: a,
			});
		}
	}
	await Promise.all(Array.from({ length: Math.min(workers, targets.length) }, worker));

	results.sort((x, y) => x.email.localeCompare(y.email));

	const dead = results.filter((r) => r.httpUser !== 200 && r.httpBilling !== 200);
	const blocked = results.filter((r) => r.blocked);
	const noCode = results.filter((r) => r.grokCode === false);
	const healthy = results.filter((r) => r.httpUser === 200 && !r.blocked && r.grokCode !== false);

	if (asJson) {
		console.log(JSON.stringify({ provider: providerName, total: accounts.length, checked: results.length,
			healthy: healthy.length, blocked: blocked.length, noGrokCode: noCode.length, unreachable: dead.length,
			accounts: results.map(({ _a, ...r }) => r) }, null, 2));
	} else {
		console.log('email'.padEnd(38) + 'user  bill  used  limit  grokCode  blocked');
		console.log('-'.repeat(84));
		for (const r of results) {
			console.log(
				String(r.email).padEnd(38) +
				String(r.httpUser).padEnd(6) +
				String(r.httpBilling).padEnd(6) +
				String(r.used ?? '-').padEnd(6) +
				String(r.monthlyLimit ?? '-').padEnd(7) +
				String(r.grokCode ?? '-').padEnd(10) +
				String(r.blocked ?? '-')
			);
		}
		console.log('\n' + '-'.repeat(84));
		console.log(`total ${accounts.length}   checked ${results.length}`);
		console.log(`  healthy      ${healthy.length}`);
		console.log(`  blocked      ${blocked.length}`);
		console.log(`  no grok-code ${noCode.length}`);
		console.log(`  unreachable  ${dead.length}`);
	}

	if (prune) {
		const bad = new Set([...blocked, ...noCode, ...dead].map((r) => r.email));
		if (!bad.size) {
			console.log('\n--prune: nothing to drop');
		} else if (healthy.length === 0) {
			console.error('\n--prune: every checked account is bad — refusing to write an empty pool');
			process.exit(1);
		} else {
			const kept = accounts.filter((a) => !bad.has(a.email));
			await sql`update provider set credentials_enc = ${encrypt(JSON.stringify({ ...blob, accounts: kept, api_key: kept[0].access_token }))} where id = ${row.id}`;
			const [chk] = await sql`select credentials_enc from provider where id = ${row.id}`;
			const back = JSON.parse(decrypt(chk.credentials_enc));
			console.log(`\n--prune: dropped ${bad.size}, pool ${accounts.length} -> ${back.accounts.length} (verified by re-reading)`);
			console.log('restart the router: Handler.pools caches the pool per provider and never reloads it');
		}
	}
} finally {
	await sql.end();
}
