/**
 * Compat API client. Base /api served by the Express compat server (S1b);
 * JSON shapes mirror the control-plane `load` payloads so routes keep their logic
 * when the server lands.
 *
 * A failure is `null`, and every caller renders its own message from that. This
 * module used to ALSO record the reason in a `lastApiError` with a
 * `getLastApiError`/`onApiError` pub-sub on top, and a `getWithStatus` that
 * reported the HTTP code — all three were exported, documented as what "routes
 * surface", and called by nothing. A second, unwired error channel beside the
 * one every route actually uses is worse than none: it reads as coverage.
 */
const BASE = '/api';
async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
/**
 * Like `get`, but keeps the HTTP status so a caller can tell "no such row" (404)
 * from "the request never landed" (null). The model, provider, doc and
 * changelog detail pages need that distinction: a 404 is a legitimate answer to
 * render, an outage is not.
 */
async function getWithStatus<T>(path: string): Promise<{ data: T | null; status: number | null }> {
  try {
    const res = await fetch(`${BASE}${path}`);
    return { data: res.ok ? ((await res.json()) as T) : null, status: res.status };
  } catch {
    return { data: null, status: null };
  }
}

export interface PriceMicro {
  inputPriceMicro: string | null;
  cachedInputPriceMicro: string | null;
  outputPriceMicro: string | null;
  reasoningPriceMicro: string | null;
  currency: string;
}

export interface CatalogProvider {
  providerName: string;
  price: PriceMicro | null;
  status: string;
  availability: number | null;
}

export interface CatalogModel {
  slug: string;
  name: string;
  developer: string | null;
  context: number | null;
  price: PriceMicro;
  providers: CatalogProvider[];
  capabilities: Record<string, boolean | null>;
}

export interface ProviderRow {
  slug: string | null;
  name: string;
  status: string;
  modelCount: number;
  capabilities: string[];
  regions: string[];
  p50Ms: number | null;
  p95Ms: number | null;
  availability: number | null;
}

export interface Metrics {
  models: number | null;
  providers: number | null;
  calls24h: number | null;
  p50Ms: number | null;
}

export interface DocEntry {
  path: string;
  title: string;
  categoryTitle: string;
  markdown: string;
}

export interface ChangelogEntry {
  slug: string;
  title: string;
  date: string;
  html: string;
}

export interface RunMetrics {
  provider: string | null;
  connection: string | null;
  actualModel: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  costMicro: string | null;
  fallback: boolean | null;
  attempts: number | null;
  status: string | null;
  requestId: string | null;
}

export interface StatusPayload {
  probe: {
    ok: boolean;
    dbUnreachable: boolean;
    error: string | null;
    service: string;
    models: number | null;
    latencyMs: number;
    checkedAt: string;
  };
  incidents:
    | {
        id: string;
        title: string;
        severity: string;
        status: string;
        statusLabel: string;
        componentLabel: string;
        startedAt: string;
        resolvedAt: string | null;
      }[]
    | null;
  dbErrorRequestId: string | null;
  components: {
    key: string;
    label: string;
    description: string;
    state: string | null;
    stateLabel: string;
    basis: string;
  }[];
  overall: { state: string | null; label: string };
}

export const api = {
  status: () => get<StatusPayload>('/status'),
  metrics: () => get<{ metrics: Metrics; sampleModels: { slug: string; name: string; context: number | null }[] }>('/metrics'),
  models: (params?: Record<string, string>) =>
    get<{ models: CatalogModel[]; total: number }>(
      `/models${params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`,
    ),
  model: (slug: string) => getWithStatus<{ model: CatalogModel | null }>(`/models/${encodeURIComponent(slug)}`),
  compare: (slugs: string[]) => get<{ columns: CatalogModel[]; missing: string[] }>(`/models/compare?models=${encodeURIComponent(slugs.join(','))}`),
  providers: () => get<{ providers: ProviderRow[] }>('/providers'),
  provider: (slug: string) => getWithStatus<{ provider: ProviderRow | null }>(`/providers/${encodeURIComponent(slug)}`),
  pricing: () => get<{ groups: { developer: string; models: { slug: string; name: string; price: PriceMicro; context: number | null; variesByProvider: boolean }[] }[]; hasReasoning: boolean }>('/pricing'),
  docs: () => get<{ categories: { slug: string; title: string; pages: DocEntry[] }[] }>('/docs'),
  doc: (path: string) => getWithStatus<{ entry: DocEntry | null; prev: DocEntry | null; next: DocEntry | null }>(`/docs/${path}`),
  changelog: () => get<{ entries: ChangelogEntry[] }>('/changelog'),
  changelogEntry: (slug: string) => getWithStatus<{ entry: ChangelogEntry | null }>(`/changelog/${encodeURIComponent(slug)}`),
};

/**
 * The catalog stores prices in micro-dollars per 1M tokens -- the same unit the
 * ledger bills in. `150000` is $0.15/1M, `120000000` is $120/1M.
 *
 * This used to multiply by 1e6 on the way in, treating the value as dollars.
 * That is right for a dollar-denominated source and wrong for every row the
 * catalog actually holds, so 238 of 690 price cells on /pricing quoted numbers
 * like $120,000,000.00 per 1M tokens and the calculator projected billions.
 */
export function priceMicro(value: string): bigint {
  const [whole = '0', frac = ''] = value.trim().split('.');
  const base = BigInt(whole);
  // numeric(18,6) gives six decimals of a micro -- that is sub-micro money and
  // the only thing worth doing with it is rounding the whole micro up.
  const firstFrac = frac.slice(0, 1);
  return firstFrac && Number(firstFrac) >= 5 ? base + 1n : base;
}

export function formatPricePer1M(value: string | null): string {
  if (value === null) return '—';
  const micro = priceMicro(value);
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  // Two decimals down to a cent; four below it, so a $0.002/1M model does not
  // print as $0.00. A free model is exactly zero and reads as $0.00 -- four
  // decimals there is just noise.
  const digits = micro === 0n || micro >= 10_000n ? 2 : 4;
  const scale = 10n ** BigInt(digits);
  const fracStr = ((frac * scale) / 1_000_000n).toString().padStart(digits, '0');
  return `$${whole}.${fracStr}`;
}

export function formatContext(tokens: number | null): string {
  if (tokens === null) return '—';
  return `${Math.round(tokens / 1000).toLocaleString('en-US')}k`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return `${ms.toLocaleString('en-US')} ms`;
}
/** Public API origin shown in curl samples and copy; build-time Vite var. */
export const API_BASE_DISPLAY = import.meta.env?.VITE_PUBLIC_API_BASE_URL ?? 'https://fudrouter.my.id';
