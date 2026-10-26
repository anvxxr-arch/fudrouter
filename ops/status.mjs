#!/usr/bin/env node
/**
 * ops/status.mjs — one-shot fudrouter health snapshot.
 *
 * Answers "is it usable?" without a manual DB dig: per-provider live
 * credentials, connection health, and the LATEST model_verification verdict
 * per mapping (pass / not_served / error / mismatch), aggregated per provider.
 *
 * Read-only. No secrets leave the process. Usage:
 *   node ops/status.mjs           # human table
 *   node ops/status.mjs --json    # machine-readable
 *   npm run status                # repo alias
 */
import postgres from 'postgres';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No .env (CI, bare shell): fall back to the ambient DATABASE_URL.
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const asJson = process.argv.includes('--json');

const wib = (ts) => {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  // WIB = UTC+7, fixed offset, no DST.
  const w = new Date(d.getTime() + 7 * 3600_000);
  return `${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`;
};

// --- queries ---------------------------------------------------------------

const conns = await sql`
  select p.slug, c.id as conn_id, c.health_status, c.enabled as conn_enabled
  from provider p
  join connection c on c.provider_id = p.id
  order by p.slug, c.priority, c.id
`;

const credAgg = await sql`
  select connection_id,
    count(*) filter (where status = 'healthy'
      and (cooldown_until is null or cooldown_until <= now()))::int as live,
    count(*) filter (where status = 'auth_failed')::int as auth_failed,
    count(*) filter (where status = 'rate_limited')::int as rate_limited,
    count(*) filter (where status = 'unknown')::int as unknown,
    count(*)::int as total,
    max(last_validated_at) as last_validated
  from credential
  group by connection_id
`;

const modelAgg = await sql`
  select provider_id, count(*)::int as enabled_models
  from provider_model
  where enabled
  group by provider_id
`;

// Latest verdict per mapping: distinct-on keeps one row per provider_model,
// which is the only verdict that reflects the provider's CURRENT state.
const verdictAgg = await sql`
  select pm.provider_id,
    mv.verdict,
    count(*)::int as n,
    max(mv.created_at) as latest
  from (
    select distinct on (provider_model_id) provider_model_id, verdict, created_at
    from model_verification
    order by provider_model_id, created_at desc
  ) mv
  join provider_model pm on pm.id = mv.provider_model_id
  group by pm.provider_id, mv.verdict
`;

const activeModels = await sql`
  select count(*)::int as n from model where status = 'active'
`;

// --- aggregate -------------------------------------------------------------

const byProvider = new Map();
for (const c of conns) {
  if (!byProvider.has(c.slug)) {
    byProvider.set(c.slug, {
      slug: c.slug, conns: [], live: 0, auth_failed: 0, rate_limited: 0,
      unknown: 0, total_creds: 0, health: 'healthy', last_validated: null,
      enabled_models: 0, verdicts: { pass: 0, not_served: 0, error: 0, mismatch: 0 },
      last_verified: null,
    });
  }
  const p = byProvider.get(c.slug);
  p.conns.push(c);
  if (c.conn_enabled && c.health_status !== 'healthy') p.health = c.health_status;
}

const credByConn = new Map(credAgg.map((r) => [r.connection_id, r]));
for (const p of byProvider.values()) {
  for (const c of p.conns) {
    const a = credByConn.get(c.conn_id);
    if (!a) continue;
    p.live += a.live;
    p.auth_failed += a.auth_failed;
    p.rate_limited += a.rate_limited;
    p.unknown += a.unknown;
    p.total_creds += a.total;
    if (a.last_validated && (!p.last_validated || a.last_validated > p.last_validated)) {
      p.last_validated = a.last_validated;
    }
  }
}

const modelsByProvider = new Map(modelAgg.map((r) => [r.provider_id, r.enabled_models]));
for (const [slug, p] of byProvider) {
  // provider_model rows carry the provider slug's id; map via any connection.
  // provider_id on provider_model equals provider.id, and we only have the
  // slug here, so resolve through the connection rows joined above.
}

// provider_model.provider_id -> provider.slug resolution
const provIdToSlug = await sql`
  select p.slug, p.id from provider p
`;
const idToSlug = new Map(provIdToSlug.map((r) => [r.id, r.slug]));
for (const [pid, n] of modelsByProvider) {
  const slug = idToSlug.get(pid);
  if (slug && byProvider.has(slug)) byProvider.get(slug).enabled_models = n;
}

for (const v of verdictAgg) {
  const slug = idToSlug.get(v.provider_id);
  const p = byProvider.get(slug);
  if (!p) continue;
  p.verdicts[v.verdict] = (p.verdicts[v.verdict] ?? 0) + v.n;
  if (v.latest && (!p.last_verified || v.latest > p.last_verified)) {
    p.last_verified = v.latest;
  }
}

// --- verdict ---------------------------------------------------------------

for (const p of byProvider.values()) {
  const v = p.verdicts;
  const verified = v.pass + v.not_served + v.error + v.mismatch;
  p.verified = verified;
  const failing = v.not_served + v.error + v.mismatch;
  if (p.live === 0 && p.auth_failed > 0) {
    p.verdict = 'DEAD';
    p.reason = `${p.auth_failed} creds auth_failed (revoked?)`;
  } else if (p.live === 0 && p.rate_limited > 0) {
    p.verdict = 'DEAD';
    p.reason = `${p.rate_limited} creds rate_limited`;
  } else if (p.live === 0 && p.unknown > 0) {
    p.verdict = 'DEAD';
    p.reason = `${p.unknown} creds unvalidated`
      + (failing > 0 ? `, ${failing}/${verified} mappings failing` : '');
  } else if (p.live === 0) {
    p.verdict = 'DEAD';
    p.reason = 'no credentials configured';
  } else if (p.health !== 'healthy') {
    p.verdict = 'DEGRADED';
    p.reason = `connection ${p.health}`;
  } else if (verified >= 1 && v.pass === 0) {
    p.verdict = 'DEGRADED';
    p.reason = `0/${verified} mappings pass`;
  } else if (verified >= 5 && v.pass / verified < 0.5) {
    p.verdict = 'DEGRADED';
    p.reason = `only ${v.pass}/${verified} mappings pass`;
  } else {
    p.verdict = 'OK';
    p.reason = '';
  }
  // A healthy base_url with zero live creds is a lie the health check tells:
  // it probes /models unauthenticated. Flag it so nobody trusts the green.
  p.health_misleading = p.health === 'healthy' && p.live === 0 && p.total_creds > 0;
}

const rows = [...byProvider.values()].sort((a, b) => {
  const order = { DEAD: 0, DEGRADED: 1, OK: 2 };
  return order[a.verdict] - order[b.verdict] || b.live - a.live || a.slug.localeCompare(b.slug);
});

const okCount = rows.filter((r) => r.verdict === 'OK').length;
const deadCount = rows.filter((r) => r.verdict === 'DEAD').length;
const degradedCount = rows.filter((r) => r.verdict === 'DEGRADED').length;
const totalLive = rows.reduce((s, r) => s + r.live, 0);

if (asJson) {
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    active_models: activeModels[0].n,
    providers: rows.map((r) => ({
      slug: r.slug, verdict: r.verdict, reason: r.reason,
      health: r.health, health_misleading: r.health_misleading,
      live_creds: r.live, auth_failed: r.auth_failed,
      rate_limited: r.rate_limited, unknown: r.unknown,
      enabled_models: r.enabled_models,
      verdicts: r.verdicts,
      last_verified: r.last_verified, last_validated: r.last_validated,
    })),
  }, null, 2));
} else {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const w = new Date(now.getTime() + 7 * 3600_000);
  console.log(`🦊 FUDROUTER STATUS — ${w.getUTCFullYear()}-${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())} ${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())} WIB`);
  console.log(`Active models: ${activeModels[0].n} | Providers: ${rows.length} (OK ${okCount} / DEGRADED ${degradedCount} / DEAD ${deadCount}) | Live creds: ${totalLive}`);
  console.log('');
  const hdr = ['PROVIDER', 'VERDICT', 'HEALTH', 'LIVE', 'DEAD', 'MODELS', 'PASS/NOT/ERR/MIS', 'VERIFIED', 'REASON'];
  const widths = [24, 9, 9, 7, 7, 7, 17, 9, 42];
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i]).slice(0, widths[i])).join(' ');
  console.log(fmt(hdr));
  console.log(widths.map((w) => '─'.repeat(w)).join(' '));
  for (const r of rows) {
    const v = r.verdicts;
    const mark = r.health_misleading ? `${r.health}*` : r.health;
    console.log(fmt([
      r.slug,
      r.verdict,
      mark,
      r.live,
      r.auth_failed + r.rate_limited,
      r.enabled_models,
      `${v.pass}/${v.not_served}/${v.error}/${v.mismatch}`,
      wib(r.last_verified),
      r.reason,
    ]));
  }
  const misleading = rows.filter((r) => r.health_misleading);
  if (misleading.length > 0) {
    console.log('');
    console.log(`* health=healthy tapi 0 live cred — health check probe /models TANPA auth, jadi "hijau" itu bohong. Provider: ${misleading.map((r) => r.slug).join(', ')}`);
  }
  const verifiedTimes = rows.filter((r) => r.last_verified).map((r) => r.last_verified.getTime()).sort((a, b) => a - b);
  if (verifiedTimes.length > 0) {
    console.log('');
    console.log(`Verification data ${wib(new Date(verifiedTimes[0]))}–${wib(new Date(verifiedTimes[verifiedTimes.length - 1]))} WIB (job model_verification, cadence harian) — bisa lag dari live state. Live cred count real-time.`);
  }
  const dead = rows.filter((r) => r.verdict === 'DEAD');
  if (dead.length > 0) {
    console.log('');
    console.log(`⚰ DEAD: ${dead.map((r) => `${r.slug} (${r.reason})`).join(' | ')}`);
  }
}

await sql.end();
