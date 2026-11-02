#!/usr/bin/env node
/**
 * ops/revalidate-zro-chat.mjs — revalidate ZRO creds with a REAL chat call.
 *
 * Why: /v1/models is free and never burns quota, so every credential looks
 * healthy even when its free plan is spent. Chat completions are the only
 * honest signal. A 402 (budget_exceeded) means SPENT, not dead — keep it,
 * mark it rate_limited so the router rotates past it.
 *
 *   node ops/revalidate-zro-chat.mjs [--limit N] [--apply] [--concurrency N]
 */
import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 8, idle_timeout: 10 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const num = (flag, dflt) => {
	const i = argv.indexOf(flag);
	return i === -1 ? dflt : Number(argv[i + 1]);
};
const LIMIT = num('--limit', 1000);
const CONC = num('--concurrency', 12);
const MODEL = 'glm-5.3-flash';

const rows = await sql.unsafe(
	`select c.id, c.secret_enc, c.status from credential c
	 join connection cn on c.connection_id = cn.id
	 where cn.provider_id = 'prv_zro'
	 order by c.status, c.updated_at desc limit ${LIMIT}`,
);
console.log(`revalidating ${rows.length} zro creds with chat (model ${MODEL}, conc ${CONC})`);

async function probe(r) {
	let key = '';
	try {
		const p = decryptCredentials(r.secret_enc);
		key = p.api_key || p.access_token || '';
	} catch (e) {
		return { id: r.id, status: 'decrypt_err', detail: String(e.message).slice(0, 60) };
	}
	if (!key) return { id: r.id, status: 'no_key', detail: '' };
	try {
		const res = await fetch('https://zro.moonmath.ai/v1/chat/completions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 2 }),
			signal: AbortSignal.timeout(45000),
		});
		const b = await res.text().catch(() => '');
		if (res.status === 200) return { id: r.id, status: 'live', detail: '' };
		if (res.status === 402) {
			// Two very different 402s hide behind one status code:
			//   "used today's Free usage. It resets in ..."  -> recovers at 00:00 UTC
			//   "used all your included credits. Top up"     -> gone for good
			// Collapsing both into rate_limited overstates the pool, so keep them apart.
			const low = b.toLowerCase();
			if (low.includes("today's free usage")) {
				const m = low.match(/resets in ([0-9hm ]+)/);
				return { id: r.id, status: 'daily', detail: m ? m[1].trim() : '' };
			}
			if (low.includes('included credits')) return { id: r.id, status: 'exhausted', detail: 'credits gone' };
			return { id: r.id, status: 'spent', detail: b.slice(0, 70) };
		}
		if (res.status === 401 || res.status === 403) return { id: r.id, status: 'dead', detail: b.slice(0, 90) };
		return { id: r.id, status: 'other', detail: `${res.status} ${b.slice(0, 70)}` };
	} catch (e) {
		return { id: r.id, status: 'err', detail: String(e.message).slice(0, 60) };
	}
}

const out = [];
let idx = 0;
await Promise.all(
	Array.from({ length: CONC }, async () => {
		while (idx < rows.length) {
			const r = rows[idx++];
			const res = await probe(r);
			out.push(res);
			if (out.length % 25 === 0) {
				const c = out.reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {});
				console.log(`  ${out.length}/${rows.length}`, JSON.stringify(c));
			}
		}
	}),
);

const counts = out.reduce((a, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {});
console.log('\n=== RESULT ===', JSON.stringify(counts));

const live = out.filter((x) => x.status === 'live').map((x) => x.id);
const daily = out.filter((x) => x.status === 'daily').map((x) => x.id);
const exhausted = out.filter((x) => x.status === 'exhausted').map((x) => x.id);
const spent = out.filter((x) => x.status === 'spent').map((x) => x.id);
const dead = out.filter((x) => x.status === 'dead' || x.status === 'decrypt_err' || x.status === 'no_key').map((x) => x.id);
console.log(`live=${live.length} daily=${daily.length} exhausted=${exhausted.length} spent=${spent.length} dead=${dead.length}`);

if (APPLY) {
	if (live.length) {
		await sql`update credential set status='healthy', cooldown_until=null, last_validated_at=now(), last_success_at=now() where id = any(${sql.array(live)}::text[])`;
	}
	if (daily.length) {
		// Free-plan quota returns at 00:00 UTC. Park them until then instead of the
		// usual 30 minutes, so the router stops retrying keys that cannot work yet.
		const nextUtcMidnight = new Date();
		nextUtcMidnight.setUTCHours(24, 0, 0, 0);
		await sql`update credential set status='rate_limited', cooldown_until=${nextUtcMidnight.toISOString()}::timestamptz, last_validated_at=now() where id = any(${sql.array(daily)}::text[])`;
	}
	if (exhausted.length) {
		// "used all your included credits" never recovers on its own — no point rotating.
		await sql`update credential set status='invalid', last_validated_at=now(), last_error_at=now(), metadata = coalesce(metadata,'{}'::jsonb) || '{"zro_error":"included credits exhausted"}'::jsonb where id = any(${sql.array(exhausted)}::text[])`;
	}
	if (spent.length) {
		// spent != broken: keep them eligible later, just rotate past them now.
		await sql`update credential set status='rate_limited', cooldown_until=now() + interval '30 minutes', last_validated_at=now() where id = any(${sql.array(spent)}::text[])`;
	}
	if (dead.length) {
		await sql`update credential set status='invalid', last_validated_at=now(), last_error_at=now() where id = any(${sql.array(dead)}::text[])`;
	}
	console.log('APPLIED.');
}
await sql.end({ timeout: 2 });
