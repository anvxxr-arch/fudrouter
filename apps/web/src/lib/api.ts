/**
 * Compat API client. Base /api served by the Express compat server (S1b);
 * JSON shapes mirror the control-plane `load` payloads so routes keep their logic
 * when the server lands.
 *
 * Failures are distinguishable from empty data: `get` records the reason in
 * `lastApiError` AND routes surface it via `useApiError` — an operator seeing
 * "could not be loaded" can tell an outage (500/network) from an empty DB.
 */
const BASE = '/api';
let lastApiError: string | null = null;
const errorListeners = new Set<(msg: string | null) => void>();
function setLastApiError(msg: string | null) {
  lastApiError = msg;
  for (const fn of errorListeners) {
    try { fn(msg); } catch { /* listener must not break fetches */ }
  }
}
/** Last failure reason recorded by `get` — null after a success. */
export function getLastApiError(): string | null {
  return lastApiError;
}
/** Subscribe to failure-reason changes; returns an unsubscribe fn. UI error states use this. */
export function onApiError(fn: (msg: string | null) => void): () => void {
  errorListeners.add(fn);
  return () => { errorListeners.delete(fn); };
}
async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) {
      setLastApiError(`${path}: ${res.status}`);
      return null;
    }
    setLastApiError(null);
    return (await res.json()) as T;
  } catch (e) {
    setLastApiError(`${path}: ${e instanceof Error ? e.message : 'network error'}`);
    return null;
  }
}
/** Like `get`, but reports the HTTP status (null when the request never landed). */
async function getWithStatus<T>(path: string): Promise<{ data: T | null; status: number | null }> {
  try {
    const res = await fetch(`${BASE}${path}`);
    setLastApiError(res.ok ? null : `${path}: ${res.status}`);
    return { data: res.ok ? ((await res.json()) as T) : null, status: res.status };
  } catch (e) {
    setLastApiError(`${path}: ${e instanceof Error ? e.message : 'network error'}`);
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

export function formatPricePer1M(value: string | null): string {
  if (value === null) return '—';
  const [whole = '0', frac = ''] = value.trim().split('.');
  const micro = BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  const dollars = Number(micro) / 1_000_000;
  return `$${dollars.toFixed(2)}`;
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
