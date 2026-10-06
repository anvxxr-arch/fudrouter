/**
 * Compat API client. Base /api served by the Express compat server (S1b);
 * JSON shapes mirror the control-plane `load` payloads so routes keep their logic
 * when the server lands. All fetches degrade to empty data, never throw.
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
  calls: number | null;
  latencyMs: number | null;
}

export interface StatusPayload {
  probe: { ok: boolean; error: string | null; service: string; models: number | null; latencyMs: number; checkedAt: string };
  components: { key: string; label: string; description: string; state: string | null; stateLabel: string; basis: string }[];
  overall: { state: string | null; label: string };
  incidents: { id: string; title: string; severity: string; status: string; statusLabel: string; componentLabel: string; startedAt: string; resolvedAt: string | null }[] | null;
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
  requestId: string | null;
}

export const api = {
  metrics: () => get<{ metrics: Metrics; sampleModels: { slug: string; name: string; context: number | null }[] }>('/metrics'),
  models: () => get<{ models: CatalogModel[]; total: number }>('/models'),
  model: (slug: string) => get<{ model: CatalogModel | null }>(`/models/${encodeURIComponent(slug)}`),
  compare: (slugs: string[]) => get<{ columns: CatalogModel[]; missing: string[] }>(`/models/compare?models=${encodeURIComponent(slugs.join(','))}`),
  providers: () => get<{ providers: ProviderRow[] }>('/providers'),
  provider: (slug: string) => get<{ provider: ProviderRow | null }>(`/providers/${encodeURIComponent(slug)}`),
  pricing: () => get<{ groups: { developer: string; models: { slug: string; name: string; price: PriceMicro; context: number | null; variesByProvider: boolean }[] }[]; hasReasoning: boolean }>('/pricing'),
  status: () => get<StatusPayload>('/status'),
  docs: () => get<{ categories: { slug: string; title: string; pages: DocEntry[] }[] }>('/docs'),
  doc: (path: string) => get<{ entry: DocEntry | null; prev: DocEntry | null; next: DocEntry | null }>(`/docs/${path}`),
  changelog: () => get<{ entries: ChangelogEntry[] }>('/changelog'),
  changelogEntry: (slug: string) => get<{ entry: ChangelogEntry | null }>(`/changelog/${encodeURIComponent(slug)}`),
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
