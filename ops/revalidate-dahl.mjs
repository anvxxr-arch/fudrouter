#!/usr/bin/env node
// ops/revalidate-dahl.mjs — re-validate dahl credentials whose status is
// `unknown` by probing the AUTH-REQUIRED /chat endpoint (not /models, which
// dahl answers 200 to unauthenticated requests — that is how 12,491 rows
// sat at `unknown` forever: the old probe could not tell a live key from a
// dead one).
//
// Writes verdict back as credential.status ('healthy' / 'invalid') and sets
// cooldown_until for rate_limited keys so the worker stops hammering them.
// No secrets leave the process.
//
// Usage:
//   node ops/revalidate-dahl.mjs                 # 120 per batch, repeat
//   node ops/revalidate-dahl.mjs --all           # everything unknown
//   PER_CONN=50 node ops/revalidate-dahl.mjs --all
import postgres from 'postgres';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {}

const BATCH = Number(process.env.BATCH ?? 120);
const ALL = process.argv.includes('--all');
const CONC = Number(process.env.FARM_PROBE_CONCURRENCY ?? 12);
const BASE = 'https://inference.dahl.global/v1';
const MODEL = 'zai-org/GLM-5.3-Flash'; // lightest model, lowest concurrency

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });

async function probe(key) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `*** ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 200) return { ok: true };
    const body = await res.text().catch(() => '');
    if (res.status === 429 || body.includes('model_concurrency') || body.includes('rate_limit')) {
      return { ok: false, rate_limited: true };
    }
    if (res.status === 401 || res.status === 403) return { ok: false };
    return { ok: false, unknown: true };
  } catch {
    return { ok: false, unknown: true };
  }
}

async function main() {
  const where = ALL
    ? `status = 'unknown'`
    : `status = 'unknown' AND (last_validated_at IS NULL OR last_validated_at < now() - interval '1 hour')`;
  const rows = await sql.unsafe(
    `select id, secret_enc from credential
     where connection_id = 'con_prv_dahl-default' and ${where}
     order by updated_at asc
     limit ${BATCH}`
  );
  if (rows.length === 0) {
    console.log('revalidate-dahl: no unknown credentials to probe');
    await sql.end({ timeout: 1 });
    return;
  }
  console.log(`revalidate-dahl: probing ${rows.length} unknown dahl credentials`);

  // Decrypt in-process, never persist.
  const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
  const tasks = rows.map(async (r) => {
    const plain = decryptCredentials(r.secret_enc);
    const key = plain.api_key;
    if (!key) return { id: r.id, ok: false };
    const v = await probe(key);
    return { id: r.id, ...v };
  });

  // bounded concurrency
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, tasks.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= tasks.length) return;
        results.push(await tasks[idx]);
      }
    })
  );

  let healthy = 0, invalid = 0, rateL = 0, unknownR = 0;
  for (const r of results) {
    if (r.ok) {
      await sql`update credential set status = 'healthy', last_validated_at = now() where id = ${r.id}`;
      healthy++;
    } else if (r.rate_limited) {
      await sql`update credential set status = 'rate_limited', cooldown_until = now() + interval '1 hour', last_validated_at = now() where id = ${r.id}`;
      rateL++;
    } else {
      await sql`update credential set status = 'invalid', last_validated_at = now() where id = ${r.id}`;
      invalid++;
    }
    unknownR += r.unknown ? 1 : 0;
  }

  const remaining = await sql`select count(*)::int from credential where connection_id = 'con_prv_dahl-default' and status = 'unknown'`;
  console.log(
    `revalidate-dahl: healthy=${healthy} invalid=${invalid} rate_limited=${rateL} ` +
    `(unknown_response=${unknownR}) — ${remaining[0].n} unknown remain`
  );
  await sql.end({ timeout: 1 });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});