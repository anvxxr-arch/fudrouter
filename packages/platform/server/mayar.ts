// packages/platform/server/mayar.ts — the Mayar gateway adapter.
//
// Mayar (https://docs.mayar.id/api-reference-v2) is ONE of the gateways the
// payment interface (gateway.ts) can drive. This module owns the advisor's HALF
// of that job — the vendor-specific vocabulary and the network call — while the
// money decisions (what plans exist, what amount must match, what status must be
// `paid`) stay where they already live: payments.ts → grant.ts →
// payment-confirm.ts. This file never re-encodes a price, a channel or a grant
// rule.
//
// Fail-closed, additive (FR-revised §M1/M2/M3): the whole adapter is inert
// until `MAYAR_API_KEY` is set. Every path that needs it calls
// `mayarClientFromEnv`, which returns `null` when the key is absent — the legacy
// `qris-native` path (gateway.ts createPayment → qrisFor) is untouched and is
// the ONLY path running when no key exists. A missing key is never a crash and
// never a fallback that fabricates a checkout link.
//
// Secrets: the API key is read from env, placed into the `Authorization` header
// by `request()`, and never logged, never embedded in an error `message`, and
// never echoed into the vendor-response parsing below. Error messages are FIXED
// strings keyed off the HTTP status — a vendor's JSON body (which may legally
// echo the request) is read only to be discarded. `assertEnvPair` decodes nothing
// that would leak the key: it reads the JWT payload claims only.
//
// Outbound transport: `guardedUpstreamFetch` (./ssrf.ts) is the default. The
// base URL is operator-overridable (`MAYAR_API_BASE`), which is exactly the
// admin-supplied-url shape the guard exists for; passing it through the guard is
// defence in depth against a typo'd/private base and pins the validated
// addresses against DNS rebinding. `redirect:'manual'` is set by the guard
// itself, so a vendor 30x can never bounce us to an unvalidated host.

import { guardedUpstreamFetch, type GuardedFetchResult } from './ssrf.ts';

/** The gateway identity `drizzleGatewayStore(db, idfn, MAYAR_GATEWAY)` scopes to. */
export const MAYAR_GATEWAY = 'mayar';

export const MAYAR_API_KEY_ENV = 'MAYAR_API_KEY';
export const MAYAR_API_BASE_ENV = 'MAYAR_API_BASE';
export const MAYAR_WEBHOOK_ENABLED_ENV = 'MAYAR_WEBHOOK_ENABLED';
export const MAYAR_API_BASE_DEFAULT = 'https://api.mayar.id/hl/v2';
export const MAYAR_TIMEOUT_MS = 15_000;

/** The failure taxonomy the settlement path and the create path answer with. */
export type MayarErrorKind = 'mayar_unavailable' | 'mayar_rejected' | 'mayar_bad_response';

/** A config mistake (sandbox/prod mix) is loud at init time, not a 401 later. */
export class MayarConfigError extends Error {
	override name = 'MayarConfigError';
}

// ------------------------------ env ------------------------------------------

/** A minimal env shape (test seam): the real `process.env` satisfies it. */
export interface MayarEnv {
	[key: string]: string | undefined;
}

/** The API key, trimmed, or null when unset — the fail-closed switch. */
export function mayarApiKey(env: MayarEnv = process.env): string | null {
	const k = env[MAYAR_API_KEY_ENV];
	return typeof k === 'string' && k.trim() !== '' ? k.trim() : null;
}

/** The API base URL, trailing slashes stripped. Defaults to Mayar production. */
export function mayarBaseUrl(env: MayarEnv = process.env): string {
	const b = env[MAYAR_API_BASE_ENV];
	return typeof b === 'string' && b.trim() !== '' ? b.trim().replace(/\/+$/, '') : MAYAR_API_BASE_DEFAULT;
}

/** Whether the inbound settlement route answers at all (default OFF). */
export function mayarWebhookEnabled(env: MayarEnv = process.env): boolean {
	return env[MAYAR_WEBHOOK_ENABLED_ENV] === 'true';
}

// --------------------------- env-pair assertion (M1) -------------------------

/**
 * Classify the environment a Mayar base URL points at. The two documented hosts
 * are `api.mayar.id` (production) and `api.mayar.io` (sandbox). Anything else is
 * `other` — an operator-specified override — and is accepted because no
 * environment can be inferred from an unknown host.
 */
function baseUrlEnvironment(baseUrl: string): 'production' | 'sandbox' | 'other' {
	let host = '';
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return 'other';
	}
	if (host === 'api.mayar.id') return 'production';
	if (host === 'api.mayar.io' || host === 'api.mayar.club') return 'sandbox';
	return 'other';
}

/**
 * Best-effort decode of a Mayar API key's JWT payload (NOT verified — this is a
 * configuration hint, never an auth decision). Returns null when the key is not
 * a three-part JWT, exactly as the vendor's own CLI resolves a key.
 */
export function jwtClaims(apiKey: string): Record<string, unknown> | null {
	const parts = apiKey.split('.');
	if (parts.length !== 3) return null;
	try {
		const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
		const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** A `api.mayar.{id,io,club}` hostname found inside an arbitrary string. */
function mayarHostIn(value: string): string | null {
	const m = value.match(/api\.mayar\.(?:id|io|club)/);
	return m ? m[0] : null;
}

/**
 * Infer the environment a key names, from hostname strings embedded in its JWT
 * claims (e.g. `iss`/`aud`). Mayar does not document an official
 * environment claim; this reads any claim-looking hostname and returns `other`
 * (unknown) when none is present.
 */
function keyEnvironment(apiKey: string): 'production' | 'sandbox' | 'other' {
	const claims = jwtClaims(apiKey);
	if (!claims) return 'other';
	for (const v of Object.values(claims)) {
		if (typeof v !== 'string') continue;
		const host = mayarHostIn(v);
		if (host === 'api.mayar.id') return 'production';
		if (host === 'api.mayar.io' || host === 'api.mayar.club') return 'sandbox';
	}
	return 'other';
}

export type EnvPairResult = { ok: true } | { ok: false; reason: string };

/**
 * Refuse the sandbox-key-on-production-base (and vice-versa) mix. Done on what
 * is OBSERVABLE, and documented: an unknown base host or a key that carries no
 * environment-naming claim is accepted (nothing to prove a mismatch), while a
 * POSITIVE conflict — the base host says one environment and a hostname inside
 * the key's claims says the other — is refused loudly. This never silently
 * disables a correct pair; it fails the one mix that would send money to the
 * wrong merchant environment.
 */
export function assertEnvPair(apiKey: string, baseUrl: string): EnvPairResult {
	if (!apiKey) return { ok: true };
	const base = baseUrlEnvironment(baseUrl);
	if (base === 'other') return { ok: true };
	const key = keyEnvironment(apiKey);
	if (key === 'other') return { ok: true };
	if (key !== base) {
		return {
			ok: false,
			reason:
				`MAYAR_API_BASE host (${baseUrl}) is ${base} but the API key names ${key}; ` +
				'mixing the sandbox and production environments is refused'
		};
	}
	return { ok: true };
}

// ------------------------------ fetch seam -----------------------------------

/** Minimal HTTP response the injected fetch hands back. */
export interface MayarHttpResponse {
	status: number;
	text(): Promise<string>;
}

export type MayarFetchResult =
	| { ok: true; response: MayarHttpResponse }
	| { ok: false; message: string };

export interface MayarRequestInit {
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
}

/**
 * The injected low-level fetch. Same shape as `guardedUpstreamFetch` so the
 * adapter composes `baseUrl + pathSuffix` itself (never letting the caller pick
 * a partial URL), and a test can pass a fake without touching the network.
 */
export type MayarFetch = (
	baseUrl: unknown,
	allowPrivate: boolean,
	pathSuffix: string,
	init: MayarRequestInit
) => Promise<MayarFetchResult>;

/** The default transport: the repo's SSRF-guarded, DNS-rebinding-pinned fetch. */
const defaultMayarFetch: MayarFetch = async (baseUrl, allowPrivate, pathSuffix, init) => {
	const res: GuardedFetchResult = await guardedUpstreamFetch(baseUrl, allowPrivate, pathSuffix, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		timeoutMs: init.timeoutMs,
		redirect: 'manual'
	});
	if (!res.ok) return { ok: false, message: res.message };
	return { ok: true, response: res.response };
};

// ------------------------------ error taxonomy -------------------------------

/** The non-ok half of every client result. `message` is FIXED text. */
export type MayarFailure = { ok: false; kind: MayarErrorKind; status?: number; message: string };

/** A typed vendor failure. `message` is FIXED text: never the vendor's JSON. */
export type MayarParse =
	| { ok: true; value: unknown }
	| MayarFailure;

function reject(kind: MayarErrorKind, status: number | undefined, message: string): MayarFailure {
	return { ok: false, kind, status, message };
}

// ------------------------------ client ---------------------------------------

/** The `data` shape `payments/create` returns. */
export interface MayarCreatedPayment {
	id: string;
	transactionId: string;
	link: string;
	redirectUrl: string | null;
}

/** The `data` shape `GET /transactions/{id}` returns (subset we decide on). */
export interface MayarTransaction {
	id: string;
	status: string;
	amount: number;
	[key: string]: unknown;
}

/** One page of `GET /transactions` (cursor-paginated balance history). */
export interface MayarTransactionPage {
	items: MayarTransaction[];
	hasMore: boolean;
	nextStartingAfter: string | null;
}

export interface MayarCreateInput {
	name: string;
	amount: number;
	email?: string;
	redirectUrl?: string;
	expiredAt?: Date;
}

export interface MayarListInput {
	limit?: number;
	startingAfter?: string | null;
}

export class MayarClient {
	private readonly opts: {
		apiKey: string;
		baseUrl: string;
		fetchFn: MayarFetch;
		timeoutMs: number;
		allowPrivate: boolean;
	};

	constructor(opts: MayarClient['opts']) {
		this.opts = opts;
	}

	/**
	 * Create a payment request. Returns the vendor facts we persist verbatim
	 * onto `payment.raw.mayar` (id + transactionId + link), or a typed failure.
	 */
	async createPayment(input: MayarCreateInput): Promise<
		{ ok: true; value: MayarCreatedPayment } | { ok: false; kind: MayarErrorKind; status?: number; message: string }
	> {
		const body: Record<string, unknown> = { name: input.name, amount: input.amount };
		if (input.email !== undefined && input.email !== '') body.email = input.email;
		if (input.redirectUrl !== undefined && input.redirectUrl !== '') body.redirectUrl = input.redirectUrl;
		if (input.expiredAt !== undefined) body.expiredAt = input.expiredAt.toISOString();

		const res = await this.request('POST', '/payments/create', body);
		if (!res.ok) return { ok: false, kind: res.kind, status: res.status, message: res.message };
		const data = res.value as Record<string, unknown>;
		const id = typeof data.id === 'string' ? data.id : '';
		const transactionId = typeof data.transactionId === 'string' ? data.transactionId : '';
		const link = typeof data.link === 'string' ? data.link : '';
		if (!id || !transactionId || !link) {
			return reject('mayar_bad_response', 200, 'Mayar response is missing id/transactionId/link');
		}
		return {
			ok: true,
			value: {
				id,
				transactionId,
				link,
				redirectUrl: typeof data.redirectUrl === 'string' ? data.redirectUrl : null
			}
		};
	}

	/**
	 * Authoritative re-fetch of one transaction. The settlement path treats the
	 * webhook as a HINT: `status`, `amount` and the transaction `id` all come
	 * from THIS call, never from the inbound body.
	 */
	async getTransaction(id: string): Promise<
		{ ok: true; value: MayarTransaction } | { ok: false; kind: MayarErrorKind; status?: number; message: string }
	> {
		const res = await this.request('GET', `/transactions/${encodeURIComponent(id)}`);
		if (!res.ok) return { ok: false, kind: res.kind, status: res.status, message: res.message };
		const data = res.value as Record<string, unknown>;
		const txId = typeof data.id === 'string' ? data.id : '';
		const status = typeof data.status === 'string' ? data.status : '';
		const amount = typeof data.amount === 'number' && Number.isFinite(data.amount) ? data.amount : NaN;
		if (!txId || !status || !Number.isFinite(amount)) {
			return reject('mayar_bad_response', 200, 'Mayar transaction is missing id/status/amount');
		}
		return { ok: true, value: { ...data, id: txId, status, amount } as MayarTransaction };
	}

	/**
	 * Cursor-paginated list of the merchant's settled transactions. Each item's
	 * transaction id (the one `payments/create` returned) is surfaced as
	 * `transactionId` (alias of `paymentLinkTransactionId`).
	 */
	async listTransactions(input: MayarListInput = {}): Promise<
		{ ok: true; value: MayarTransactionPage } | { ok: false; kind: MayarErrorKind; status?: number; message: string }
	> {
		const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit ?? 50))));
		let path = `/transactions?limit=${limit}`;
		if (input.startingAfter) path += `&startingAfter=${encodeURIComponent(String(input.startingAfter))}`;

		const res = await this.requestRaw('GET', path);
		if (!res.ok) return res;
		const env = res.value as Record<string, unknown>;
		const rawItems = Array.isArray(env.data) ? (env.data as unknown[]) : [];
		const items = rawItems
			.map((it) => (it && typeof it === 'object' ? (it as Record<string, unknown>) : null))
			.filter((it): it is Record<string, unknown> => it !== null)
			.map((it) => {
				const txId =
					typeof it.transactionId === 'string'
						? it.transactionId
						: typeof it.paymentLinkTransactionId === 'string'
							? it.paymentLinkTransactionId
							: '';
				const status = typeof it.status === 'string' ? it.status : '';
				const amount = typeof it.amount === 'number' && Number.isFinite(it.amount) ? it.amount : NaN;
				return { ...it, id: txId, status, amount } as MayarTransaction;
			});
		return {
			ok: true,
			value: {
				items,
				hasMore: env.hasMore === true,
				nextStartingAfter: typeof env.nextStartingAfter === 'string' ? env.nextStartingAfter : null
			}
		};
	}

	/** Envelope-only call; `request` below wraps this to lift the `data` field. */
	private async requestRaw(
		method: 'GET' | 'POST',
		path: string,
		body?: Record<string, unknown>
	): Promise<MayarParse> {
		const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` };
		if (method === 'POST') headers['content-type'] = 'application/json';
		const init: MayarRequestInit = {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			timeoutMs: this.opts.timeoutMs
		};

		let upstream: MayarFetchResult;
		try {
			upstream = await this.opts.fetchFn(this.opts.baseUrl, this.opts.allowPrivate, path, init);
		} catch (err) {
			return reject('mayar_unavailable', undefined, `Mayar request failed (${err instanceof Error ? err.name : 'unknown'})`);
		}

		if (!upstream.ok) {
			// The guard's message is the only safe text — it names the guard,
			// never the target. It still must never carry our key.
			return reject('mayar_unavailable', undefined, `Mayar request blocked (${upstream.message})`);
		}

		const status = upstream.response.status;
		// Read and DISCARD the body everywhere except the 2xx parse below. The
		// vendor's JSON can echo the request; folding it into an error would leak.
		let text = '';
		try {
			text = await upstream.response.text();
		} catch {
			text = '';
		}

		if (status >= 500) return reject('mayar_unavailable', status, `Mayar upstream error (HTTP ${status})`);
		if (status === 401 || status === 403) return reject('mayar_rejected', status, 'Mayar rejected the request (authorization)');
		if (status === 429) return reject('mayar_rejected', status, 'Mayar rate-limited the request');
		if (status === 400 || status === 404 || status === 409) {
			return reject('mayar_rejected', status, `Mayar rejected the request (HTTP ${status})`);
		}
		if (status < 200 || status >= 300) {
			return reject('mayar_bad_response', status, `Mayar answered an unexpected status (HTTP ${status})`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return reject('mayar_bad_response', status, 'Mayar returned an unparseable response');
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return reject('mayar_bad_response', status, 'Mayar returned a non-object response');
		}
		return { ok: true, value: parsed };
	}

	private async request(
		method: 'GET' | 'POST',
		path: string,
		body?: Record<string, unknown>
	): Promise<MayarParse> {
		const res = await this.requestRaw(method, path, body);
		if (!res.ok) return res;
		const env = res.value as Record<string, unknown>;
		const data = env.data;
		if (data === undefined) return reject('mayar_bad_response', 200, 'Mayar response is missing data');
		return { ok: true, value: data };
	}
}

/**
 * Build the client from env, or `null` when `MAYAR_API_KEY` is unset (the
 * fail-closed switch). Throws `MayarConfigError` when the key/base pair is a
 * provable sandbox-production mix — a config bug that should fail loudly, not
 * silently disable the gateway or, worse, mint a link on the wrong merchant.
 */
export function mayarClientFromEnv(env: MayarEnv = process.env, fetchFn: MayarFetch = defaultMayarFetch): MayarClient | null {
	const apiKey = mayarApiKey(env);
	if (!apiKey) return null;
	const baseUrl = mayarBaseUrl(env);
	const pair = assertEnvPair(apiKey, baseUrl);
	if (!pair.ok) throw new MayarConfigError(pair.reason);
	return new MayarClient({
		apiKey,
		baseUrl,
		fetchFn,
		timeoutMs: MAYAR_TIMEOUT_MS,
		allowPrivate: false
	});
}