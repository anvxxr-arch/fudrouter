/**
 * Input bounds for the admin console.
 *
 * Every action on `/admin/providers/[id]` takes text from a form and forwards it
 * either to Postgres or to an upstream over the network, so each field needs a
 * bound before it is used:
 *
 *   - a priority of `1e308` reaches an `integer` column and fails as a 500
 *   - an unbounded `payload` batch turns one POST into thousands of inserts
 *   - a slug reaches the upstream verbatim, so control characters travel with it
 *   - an out-of-range credential index silently probes with an empty token, which
 *     upstreams answer with an unrelated 401 and a misleading test result
 *
 * Rejecting is a 400 with a reason; clamping is used only where a sane value
 * exists and refusing would block legitimate work.
 */
import { isBlockedLiteral } from './ssrf';

/** Models accepted in one enable/disable POST. Above this the request is truncated. */
export const MAX_BATCH_MODELS = 500;
/** Longest chat message the playground will send upstream. */
export const MAX_CHAT_CHARS = 8_000;
/** Slugs are forwarded to the upstream, so keep them short and printable. */
export const MAX_SLUG_CHARS = 200;
export const MAX_NAME_CHARS = 200;
/** Sanity bound on a context window; anything larger is a broken payload. */
export const MAX_CONTEXT_TOKENS = 20_000_000;
/** Sanity bound on a display price, USD per 1M tokens. */
export const MAX_PRICE_USD = 1_000_000;
export const MAX_PRIORITY = 10_000;
export const MIN_PRIORITY = 0;

const TIERS = ['all', 'free', 'paid', 'unknown'] as const;
export type TierFilter = (typeof TIERS)[number];

/** The filter the gallery understands; anything else falls back to `all`. */
export function parseTier(value: unknown): TierFilter {
	const s = String(value ?? '');
	return (TIERS as readonly string[]).includes(s) ? (s as TierFilter) : 'all';
}

/**
 * A slug is sent upstream as the `model` field, so whitespace or a control
 * character inside it is not a cosmetic problem — it changes the request.
 */
export function cleanSlug(value: unknown, max = MAX_SLUG_CHARS): string | null {
	const s = String(value ?? '').trim();
	if (!s || s.length > max) return null;
	// eslint-disable-next-line no-control-regex
	if (/[\s\u0000-\u001f\u007f]/.test(s)) return null;
	return s;
}

/**
 * Free text (a chat message). Newlines and tabs are legitimate here, so only
 * control characters that would break a JSON body are stripped.
 */
export function cleanText(value: unknown, max = MAX_CHAT_CHARS): string | null {
	const s = String(value ?? '').trim();
	if (!s || s.length > max) return null;
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Priority must be a whole number in range: the column is an `integer`. */
export function parsePriority(value: unknown): number | null {
	const raw = String(value ?? '').trim();
	if (raw === '') return null;
	const n = Number(raw);
	if (!Number.isInteger(n)) return null;
	if (n < MIN_PRIORITY || n > MAX_PRIORITY) return null;
	return n;
}

/**
 * A credential index must address a credential that exists. Without this an
 * `index=999` probes with an empty token and reports a 401 that has nothing to
 * do with the provider.
 */
export function parseIndex(value: unknown, count: number): number | null {
	const raw = String(value ?? '').trim();
	if (raw === '') return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n >= count) return null;
	return n;
}

/**
 * Hosts an admin-provided `base_url` must never reach.
 *
 * `base_url` is attacker-controllable by anyone holding `admin.providers` (and,
 * before the privilege-ordering fix, by a self-promoted `finance_admin`), and the
 * provider page fetches `<base_url>/models` and `<base_url>/chat/completions`
 * server-side — so without this a base_url of `http://127.0.0.1:5432` or
 * `http://169.254.169.254/` turns those actions into an SSRF probe of the
 * loopback/LAN/metadata surface. Blocks literal private addresses, loopback,
 * link-local and CGNAT. A DNS name that resolves to a private address still needs
 * a dial-time check (out of scope here); this closes the literal-IP case.
 *
 * Escapable via `ALLOW_PRIVATE_UPSTREAMS` because this deployment legitimately
 * runs local upstreams (the seed provider is `http://127.0.0.1:20128/v1`).
 */
function isBlockedHost(host: string): boolean {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	// One rule, not two: this used to be its own copy of the blocklist and was
	// missing 0.0.0.0, ::, 198.18/15, ::ffff: mapped IPv6 and fe80::%zone, so a
	// stored base_url naming any of those passed as "public".
	return isBlockedLiteral(h);
}

/**
 * Only http(s), never with credentials embedded, never with a fragment.
 *
 * `allowPrivate` (from `ALLOW_PRIVATE_UPSTREAMS`) relaxes the loopback/private
 * block for a deployment whose upstreams are local. It is an explicit argument
 * rather than an env read so this module stays pure and testable.
 */
export function safeUpstreamUrl(baseUrl: unknown, allowPrivate = false): string | null {
	let u: URL;
	try {
		u = new URL(String(baseUrl ?? '').trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	// `https://user:pass@host` puts a secret in every log line and error message.
	if (u.username || u.password) return null;
	// A private/loopback/link-local target turns this fetch into an SSRF probe.
	if (!allowPrivate && isBlockedHost(u.hostname)) return null;
	u.hash = '';
	return u.toString().replace(/\/$/, '');
}

function boundNumber(value: unknown, max: number): number | null {
	const raw = String(value ?? '').trim();
	// `Number('')` is 0, so an absent field would silently become a zero context
	// window instead of "not reported".
	if (raw === '') return null;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return null;
	return Math.min(n, max);
}

export interface CleanModelPayload {
	slug: string;
	name: string;
	context: number | null;
	/** USD per 1M tokens, already clamped into a sane range. */
	inputUsd: number;
	outputUsd: number;
}

/**
 * One gallery payload, validated. Returns null when the entry cannot be trusted
 * — a missing slug is the important case, because such a row would be inserted
 * with an empty slug and then never match a request.
 */
export function cleanModelPayload(raw: string): CleanModelPayload | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const entry = parsed as Record<string, unknown>;

	const slug = cleanSlug(entry.slug);
	if (!slug) return null;

	const name = String(entry.name ?? slug)
		.trim()
		.slice(0, MAX_NAME_CHARS);
	const context = boundNumber(entry.context, MAX_CONTEXT_TOKENS);

	return {
		slug,
		name: name || slug,
		context: context === null ? null : Math.round(context),
		inputUsd: boundNumber(entry.inputUsd, MAX_PRICE_USD) ?? 0,
		outputUsd: boundNumber(entry.outputUsd, MAX_PRICE_USD) ?? 0
	};
}

/**
 * A whole gallery submission. Over-cap entries are dropped rather than rejected
 * so a select-all on a huge catalog still does the first page of work, and the
 * caller can say how many were left out. Duplicates are counted separately from
 * invalid rows because they are not the same problem.
 */
export function parseModelPayloads(raw: string[]): {
	rows: CleanModelPayload[];
	rejected: number;
	duplicates: number;
	overCap: number;
} {
	const overCap = Math.max(0, raw.length - MAX_BATCH_MODELS);
	const rows: CleanModelPayload[] = [];
	const seen = new Set<string>();
	let rejected = 0;
	let duplicates = 0;

	for (const item of raw.slice(0, MAX_BATCH_MODELS)) {
		const row = cleanModelPayload(item);
		if (!row) {
			rejected += 1;
			continue;
		}
		// A duplicate inside one batch would insert twice and report the second
		// failure as "owned elsewhere", which is not what happened.
		if (seen.has(row.slug)) {
			duplicates += 1;
			continue;
		}
		seen.add(row.slug);
		rows.push(row);
	}

	return { rows, rejected, duplicates, overCap };
}

/** Slugs for a disable POST: cleaned, de-duplicated, capped. */
export function parseSlugList(raw: string[]): { slugs: string[]; overCap: number } {
	const overCap = Math.max(0, raw.length - MAX_BATCH_MODELS);
	const slugs = [...new Set(raw.map((s) => cleanSlug(s)).filter((s): s is string => s !== null))];
	return { slugs: slugs.slice(0, MAX_BATCH_MODELS), overCap };
}
