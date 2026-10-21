import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import express from 'express';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
	pgTable,
	text,
	timestamp,
	boolean,
	jsonb,
	integer,
	bigint,
	index
} from 'drizzle-orm/pg-core';
import { betterAuth, APIError } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { uuidv7 } from 'uuidv7';
import { registerPlayground } from './playground.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { registerPages } from './pages.mjs';
import { registerPublicRoutes } from './public.mjs';
import { rateLimit } from './rate-limit.mjs';
import { joinFudcourt } from './lib/discord.mjs';
import { emailAuthEnabled } from './lib/auth-config.mjs';
import { compress } from './lib/compress.mjs';
import { clientIp, requestOrigin } from './lib/ip.mjs';
import { readShell, withHead, seo } from './lib/head.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
// The deployed bundle's timestamp — the sitemap's lastmod. Resolved once at
// import: the value is a property of the build, not of the request.
const BUILD_TIME = (() => {
  try {
    return statSync(path.join(DIST, 'index.html')).mtimeMs;
  } catch {
    return Date.now();
  }
})();

// ---------------------------------------------------------------- tables ----
// Minimal column copies of packages/platform/server/db/{auth.schema,schema}.ts
// (same table/column names so better-auth + the palette/shell queries behave
// identically). Only columns this server reads/writes are declared.

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').default(false).notNull(),
	image: text('image'),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
	role: text('role'),
	banned: boolean('banned').default(false),
	banReason: text('ban_reason'),
	banExpires: timestamp('ban_expires')
});
export const session = pgTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: timestamp('expires_at').notNull(),
		token: text('token').notNull().unique(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		impersonatedBy: text('impersonated_by')
	},
	(table) => [index('session_userId_idx').on(table.userId)]
);
export const account = pgTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: timestamp('access_token_expires_at'),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
		scope: text('scope'),
		password: text('password'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').notNull()
	},
	(table) => [index('account_userId_idx').on(table.userId)]
);
export const verification = pgTable(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull()
	},
	(table) => [index('verification_identifier_idx').on(table.identifier)]
);

export const apiKey = pgTable('api_key', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	name: text('name').notNull(),
	prefix: text('prefix').notNull(),
	keyHash: text('key_hash').notNull(),
	status: text('status').notNull().default('active'),
	policy: jsonb('policy').$type().notNull().default({}),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const provider = pgTable('provider', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug')
});
export const model = pgTable('model', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	developer: text('developer'),
	status: text('status').notNull().default('active')
});
export const requestLog = pgTable('request_log', {
	id: text('id').primaryKey(),
	status: text('status').notNull(),
	endpoint: text('endpoint'),
	// The palette's request search is bound to the caller's account. The
	// predicate must be expressed through this object: reaching for an
	// undeclared column silently compiles to an EMPTY column reference
	// (`and  = $2`) — a 500 at runtime, which is how the first attempt at the
	// tenant-isolation fix failed.
	userId: text('user_id'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
// `workspace`, `workspace_role`, `workspace_member`, `project` and
// `environment` were dropped by migration 0019; the account is the tenant.
export const billingAccount = pgTable('billing_account', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull()
});
export const auditLog = pgTable('audit_log', {
	id: text('id').primaryKey(),
	actorUserId: text('actor_user_id'),
	actorKind: text('actor_kind').notNull().default('user'),
	action: text('action').notNull(),
	resource: text('resource').notNull(),
	resourceId: text('resource_id'),
	// `workspace_id` exists in the table as historical evidence only; 0019
	// stopped writing it, so it is not declared here and never inserted.
	ip: text('ip'),
	before: jsonb('before').$type(),
	after: jsonb('after').$type(),
	metadata: jsonb('metadata').$type().notNull().default({})
});

// ------------------------------------------------------------------- db -----
const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) console.warn('[console/server] DATABASE_URL is not set; DB routes will 500');
const client = DATABASE_URL ? postgres(DATABASE_URL) : null;
export const db = client
	? drizzle(client, {
			schema: {
				user,
				session,
				account,
				verification,
				apiKey,
				provider,
				model,
				requestLog,
				billingAccount,
				auditLog
			}
		})
	: null;
function needDb(res) {
	if (!db) {
		res.status(500).json({ error: 'Database unavailable' });
		return null;
	}
	return db;
}

// ------------------------------------------------------------ id/audit ------
const ID_PREFIXES = {
	user: 'usr_',
	apiKey: 'key_',
	provider: 'prv_',
	model: 'mdl_',
	request: 'req_',
	billingAccount: 'bac_',
	auditLog: 'aud_',
	session: 'ses_',
	account: 'acc_',
	verification: 'ver_'
};
function newId(prefix) {
	if (!/^[a-z]{2,6}_$/.test(prefix)) throw new Error(`invalid id prefix: ${JSON.stringify(prefix)}`);
	return prefix + uuidv7();
}
const AUTH_ID_PREFIX = {
	user: ID_PREFIXES.user,
	session: ID_PREFIXES.session,
	account: ID_PREFIXES.account,
	verification: ID_PREFIXES.verification
};
// Same redaction contract as the shared audit writer: secret-looking keys never persist.
const SECRET_KEY_RE = /secret|token|password|key_hash|credentials?/i;
function redactSecrets(value) {
	if (Array.isArray(value)) return value.map(redactSecrets);
	if (value && typeof value === 'object') {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === 'api_key' || k === 'authorization' || SECRET_KEY_RE.test(k)) out[k] = '[redacted]';
			else out[k] = redactSecrets(v);
		}
		return out;
	}
	return value;
}
// Real client IP lives in server/lib/ip.mjs. The previous version trusted the
// FIRST X-Forwarded-For hop with no proxy check, so any caller could pick its own
// rate-limit bucket (and poison audit_log.ip) by sending a random header.
export { clientIp };
async function writeAudit(dbtx, entry) {
	await dbtx.insert(auditLog).values({
		id: newId(ID_PREFIXES.auditLog),
		actorUserId: entry.actorUserId ?? null,
		actorKind: entry.actorKind ?? (entry.actorUserId ? 'user' : 'system'),
		action: entry.action,
		resource: entry.resource,
		resourceId: entry.resourceId ?? null,
		ip: entry.ip ?? null,
		before: entry.before ? redactSecrets(entry.before) : null,
		after: entry.after ? redactSecrets(entry.after) : null,
		metadata: entry.metadata ? redactSecrets(entry.metadata) : {}
	});
}

// ------------------------------------------------------------ provision ----
// An account is the tenant (migration 0019): a new user gets a billing account
// and nothing else. The workspace → project → environment tree this function
// used to build was scaffolding — every key, budget and routing policy now hangs
// off the user id directly, so there is nothing to create.
//
// The billing account is NOT optional: without one the router treats the user as
// an S0 tenant with no credit line, and usage is recorded but never charged.
async function provisionAccount(dbtx, opts) {
	const billingAccountId = newId(ID_PREFIXES.billingAccount);
	await dbtx.insert(billingAccount).values({ id: billingAccountId, userId: opts.userId });
	await writeAudit(dbtx, {
		actorUserId: opts.userId,
		action: 'account.provision',
		resource: 'billing_account',
		resourceId: billingAccountId,
		ip: opts.ip ?? null,
		metadata: { userId: opts.userId }
	});
	return { billingAccountId };
}
// Idempotent: called from the sign-up hook AND from the shell endpoint, so a
// user created before 0019 (or by a path that skipped the hook) still gets an
// account on first load instead of seeing a permanent "no credit line".
async function ensureUserAccount(dbtx, opts) {
	const [existing] = await dbtx
		.select({ id: billingAccount.id })
		.from(billingAccount)
		.where(eq(billingAccount.userId, opts.userId))
		.limit(1);
	if (existing) return { billingAccountId: existing.id };
	return provisionAccount(dbtx, opts);
}

// ----------------------------------------------------------------- auth ----
const ORIGIN = process.env.ORIGIN || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const authSchema = { user, session, account, verification };
export const auth = betterAuth({
	baseURL: ORIGIN,
	secret: process.env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db ?? {}, { provider: 'pg', schema: authSchema }),
	// better-auth returns ONLY the fields it knows about. `role` was never
	// declared, so getSessionUser() handed the admin gate a user object whose
	// keys were [name,email,emailVerified,image,createdAt,updatedAt,id] --
	// requireCap(userRow.role) then read undefined and EVERY /api/admin/* route
	// answered 403, for every role including admin (measured over HTTP: the row
	// in the database said 'admin' while the route said Forbidden). Declaring it
	// is what makes the app's own role whitelist reachable at all.
	//
	// input:false is load-bearing: with better-auth's default the sign-up body
	// could set its own role, which is privilege escalation by another name.
	user: {
		additionalFields: {
			role: { type: 'string', required: false, input: false }
		}
	},
	advanced: {
		database: {
			generateId: ({ model: m }) => newId(AUTH_ID_PREFIX[m] ?? 'id_')
		},
		// Without this better-auth cannot resolve a client IP from the multi-hop
		// X-Forwarded-For we forward, so its limiter collapses into ONE shared
		// per-path bucket (throttling every user together). Trusting the loopback
		// hop makes it walk right-to-left exactly like lib/ip.mjs does.
		ipAddress: {
			ipAddressHeaders: ['x-forwarded-for'],
			trustedProxies: ['127.0.0.1', '::1']
		}
	},
	databaseHooks: {
		user: {
			create: {
				after: async (created) => {
					if (!db) throw new Error('DATABASE_URL is not set; cannot provision account');
					await db.transaction(async (tx) => {
						await provisionAccount(tx, { userId: created.id });
					});
				}
			}
		},
		session: {
			create: {
				// BAN-REVOCATION: better-auth core's sign-in mints a session without
				// consulting `banned` (dist/api/routes/sign-in.mjs createSession),
				// and the admin plugin that would refuse it is deliberately not
				// loaded (see the "No plugins" note below). This hook is the
				// sanctioned enforcement point — it mirrors the admin plugin's own
				// session.create.before (dist/plugins/admin/admin.mjs:33-51).
				// A ban whose banExpires window has already passed is not in force.
				before: async (session, ctx) => {
					if (!db || !ctx) return;
					const rows = await db
						.select({ banned: user.banned, banExpires: user.banExpires })
						.from(user)
						.where(eq(user.id, session.userId))
						.limit(1);
					const row = rows[0];
					if (row?.banned && !(row.banExpires && row.banExpires.getTime() < Date.now())) {
						throw new APIError('FORBIDDEN', { message: 'You have been banned from this application' });
					}
				},
				// After every sign-in, put the user into the FUDCourt Discord
				// server (spec: login is Discord-only and lands you in the
				// server). A NEW SESSION is the right trigger rather than
				// `user.create.after` — that hook fires exactly once, for the
				// very first sign-up, so a member who is later kicked would
				// never be re-added; and rather than every authenticated
				// request, which would put a Discord API round trip on the hot
				// path of every page load for a state we do not read back.
				//
				// Fire-and-forget on purpose: see lib/discord.mjs — a Discord
				// outage must not turn a successful login into a 500, and
				// awaiting it would add outbound latency to every sign-in.
				after: async (session) => {
					if (!db) return;
					try {
						const rows = await db
							.select({ accountId: account.accountId })
							.from(account)
							.where(and(eq(account.userId, session.userId), eq(account.providerId, 'discord')))
							.limit(1);
						const discordId = rows[0]?.accountId;
						if (!discordId) return;
						// Deliberately not awaited: `after` hooks are awaited by
						// better-auth, and `fetch` has no timeout of its own, so
						// an unreachable Discord would hold the login response
						// open for as long as the socket decides to linger. The
						// local lookup above is cheap; the outbound call is not
						// ours to block on.
						void joinFudcourt(discordId)
							.then((status) => {
								// `null` = no bot token configured (skipped
								// silently by design). Anything else non-2xx
								// means the bot is not in the guild or the user
								// denied `guilds.join`, and that IS worth a log
								// line — it is the only signal that the feature
								// is quietly not working.
								if (status !== null && (status < 200 || status >= 300)) {
									console.warn(`[auth] discord guild join for user ${session.userId} answered ${status}`);
								}
							})
							.catch((err) => {
								console.warn('[auth] discord guild join failed:', err?.message ?? err);
							});
					} catch (err) {
						console.warn('[auth] discord guild join lookup failed:', err?.message ?? err);
					}
				}
			}
		}
	},
	// Origin allow-list. An EMPTY array in production meant only baseURL
	// (ORIGIN) was accepted, so the moment the product answers on more than one
	// hostname every mutating auth request arriving on the other host is
	// refused with 403 "invalid origin" before Discord is ever reached. The
	// legacy ai.karepmuwes.my.id name was trusted for that reason, but it was
	// retired on 2026-10-21: fudrouter.my.id is the single product host, and a
	// second trusted origin would keep accepting auth for a name that no longer
	// resolves to this app. ORIGIN stays listed explicitly so a later rotation
	// of ORIGIN cannot leave baseURL untrusted.
	trustedOrigins: process.env.NODE_ENV === 'production'
		? [ORIGIN, 'https://fudrouter.my.id', 'https://www.fudrouter.my.id']
		: ['http://localhost:3000', 'http://127.0.0.1:3000'],
	// Discord is the only way in. `emailAuthEnabled` decides the one exception
	// (the integration harness); lib/auth-config.mjs records why it is keyed
	// on the literal string 'test' rather than an env var.
	emailAndPassword: { enabled: emailAuthEnabled(process.env.NODE_ENV) },
	// better-auth's own limiter was OFF and the express limiter never covered
	// /api/auth/*, so sign-in/sign-up were unthrottled (14 rapid failed logins
	// returned 14x401). This is a backstop; the express limiter is the primary.
	rateLimit: {
		enabled: true,
		window: 60,
		max: 100,
		customRules: {
			'/sign-in/email': { window: 60, max: 10 },
			'/sign-up/email': { window: 60, max: 5 },
			'/forget-password': { window: 60, max: 5 },
			'/reset-password': { window: 60, max: 5 }
		}
	},
	...(process.env.FLEXYROUTE_CLIENT_ID && process.env.FLEXYROUTE_CLIENT_SECRET
		? {
				socialProviders: {
					discord: {
						clientId: process.env.FLEXYROUTE_CLIENT_ID,
						clientSecret: process.env.FLEXYROUTE_CLIENT_SECRET,
						redirectURI: `${ORIGIN}/api/auth/callback/discord`,
						prompt: 'consent',
						// `guilds.join` is required, not decoration: without it
						// the post-login add-to-server call is refused with 403
						// "Missing Access" for every single user. Better-auth's
						// Discord default is `identify email` and it is kept, so
						// only the extra scope is listed here (lib/discord.mjs).
						//
						// MUST BE AN ARRAY. ProviderOptions.scope is typed
						// string[] and the provider does `_scopes.push(...scope)`,
						// so the space-separated string this used to be was spread
						// into single characters: the authorize URL went out as
						// scope=identify+email+i+d+e+n+t+i+f+y+...+g+u+i+l+d+s+.+
						// j+o+i+n and Discord answered HTTP 400, which killed
						// sign-in for every user on every hostname.
						scope: ['guilds.join']
					}
				}
			}
		: {})
	// No plugins: better-auth's admin plugin exposed /api/auth/admin/* with its own
	// user/admin role model, which does not match this app's user/finance_admin/
	// ops_admin/admin roles. Admin actions are served from /api/admin/* (admin.mjs)
	// with the app's own role whitelist, dominance checks and audit rows.
});

// ------------------------------------------------------------- caps/rbac ----
// ROLE_CAPS/capsFor live in server/lib/rbac.mjs (shared with admin.mjs); they
// are re-exported here so existing importers of index.mjs keep working.
export { ROLE_CAPS, capsFor } from './lib/rbac.mjs';
import { ROLE_CAPS, capsFor } from './lib/rbac.mjs';
function parseCookies(req) {
	const out = {};
	for (const part of String(req.headers.cookie || '').split(';')) {
		const i = part.indexOf('=');
		if (i > 0) {
			try {
				out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
			} catch {
				out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
			}
		}
	}
	return out;
}
async function getSessionUser(req) {
	const headers = new Headers();
	if (req.headers.cookie) headers.set('cookie', req.headers.cookie);
	const data = await auth.api.getSession({ headers });
	const sessionUser = data?.user ?? null;
	if (!sessionUser) return null;
	// BAN-REVOCATION: better-auth core validates a session by expiry only
	// (dist/api/routes/session.mjs findSession) and the admin plugin that would
	// enforce `banned` is deliberately not loaded (see the "No plugins" note on
	// the config below), so without this gate a banned user's cookie validates
	// forever. A ban whose banExpires window has already passed is not in force.
	const [row] = await db
		.select({ banned: user.banned, banExpires: user.banExpires })
		.from(user)
		.where(eq(user.id, sessionUser.id))
		.limit(1);
	if (row?.banned && !(row.banExpires && row.banExpires.getTime() < Date.now())) return null;
	return sessionUser;
}
class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}
function requireCap(userRow, cap) {
	if (!userRow) throw new HttpError(401, 'Authentication required');
	if (!capsFor(userRow.role).has(cap)) throw new HttpError(403, 'Forbidden');
}
// --------------------------------------------------------------- palette ----
function escapeLike(q) {
	return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}
function likePattern(q, kind = 'contains') {
	const escaped = escapeLike(q);
	return kind === 'prefix' ? `${escaped}%` : `%${escaped}%`;
}
function paletteParams(url) {
	const q = (url.searchParams.get('q') ?? '').trim().replace(/\s+/g, ' ');
	const raw = url.searchParams.get('limit');
	const parsed = raw === null || raw === '' ? Number.NaN : Number(raw);
	const limit = Number.isFinite(parsed) ? Math.min(20, Math.max(1, Math.floor(parsed))) : 8;
	return { q, limit };
}

// ------------------------------------------------------------------ app -----
const app = express();
app.disable('x-powered-by');
// Compression first, so every response below (static assets, pages JSON, SSE)
// sees it. It sets Vary and decides per-response whether to encode; SSE and
// already-encoded bodies are left untouched -- see lib/compress.mjs.
app.use(compress());
// Security headers (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, CSP) are owned SOLELY by Caddy (header block in the
// Caddyfile): emitting them here too would send duplicates. Only the
// fingerprint stays off here; HSTS/CSP stay at the edge (Caddy/cloudflared)
// so the app never contradicts the TLS terminator.
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ------------------------------------------------------- rate limiting ----
// Keyed on the real client IP (lib/ip.mjs — X-Forwarded-For is only honoured
// from a trusted proxy), so a spoofed header can no longer mint a fresh bucket.
const _ipKey = async (req) => `ip:${clientIp(req) ?? 'unknown'}`;
const _authLoose = rateLimit({ windowMs: 60_000, max: 120, key: _ipKey });
const _authStrict = rateLimit({ windowMs: 60_000, max: 10, key: _ipKey });
// Credential-bearing endpoints get the strict bucket; the rest of /api/auth
// (session polling, OAuth callbacks) gets the loose one so the app keeps working.
const _AUTH_SENSITIVE = /^\/(sign-in|sign-up|forget-password|reset-password|change-password|change-email|verify-email|send-verification-email|two-factor|delete-user)/;
app.use('/api/auth', (req, res, next) => {
	const strict = req.method === 'POST' && _AUTH_SENSITIVE.test(req.path);
	return (strict ? _authStrict : _authLoose)(req, res, next);
});

// better-auth node handler at /api/auth/* (registered before express.json so
// the raw body stream stays intact for the Web Request we forward).
app.all('/api/auth/{*path}', async (req, res) => {
	try {
		// The origin better-auth sees is fixed to ORIGIN, never derived from
		// the request Host header: Host is attacker-controllable and would
		// otherwise poison origin/redirect checks (reset links, OAuth
		// redirect_uri, CSRF-origin validation).
		const url = `${ORIGIN}${req.originalUrl}`;
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (v === undefined || k === 'content-length' || k === 'connection') continue;
			if (Array.isArray(v)) {
				for (const x of v) headers.append(k, x);
			} else {
				headers.set(k, String(v));
			}
		}
		// AUTH-1: this handler runs BEFORE express.json({limit:'1mb'}), so the
		// raw-body buffering below is the only size gate on the auth surface —
		// and it had none. An unauthenticated client could stream an unbounded
		// body (declared content-length or chunked) into `chunks` and exhaust
		// server memory. The cap mirrors express.json's 1mb so the auth surface
		// is never more permissive than the JSON surfaces behind it.
		const AUTH_BODY_LIMIT = 1024 * 1024;
		const declared = Number(req.headers['content-length']);
		if (Number.isFinite(declared) && declared > AUTH_BODY_LIMIT) {
			// Declared over-limit: reject before consuming a single byte —
			// reading it first would be the DoS this cap exists to stop.
			res.status(413).json({ error: 'Request body too large' });
			return;
		}
		const chunks = [];
		let size = 0;
		for await (const c of req) {
			size += c.length;
			if (size > AUTH_BODY_LIMIT) {
				// Chunked bodies carry no content-length, so the cap has to hold
				// during accumulation too. Destroyed on 'finish' so the 413 is
				// flushed to the client before the socket dies (an immediate
				// destroy depends on write ordering to win the race); a client
				// that keeps streaming then cannot hold the request alive.
				res.status(413).json({ error: 'Request body too large' });
				res.on('finish', () => req.destroy());
				return;
			}
			chunks.push(c);
		}
		const raw = chunks.length ? Buffer.concat(chunks) : null;
		const webReq = new Request(url, {
			method: req.method,
			headers,
			body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw,
			duplex: 'half'
		});
		const webRes = await auth.handler(webReq);
		// BAN-REVOCATION: better-auth core's /get-session validates the session
		// row by expiry only (dist/api/routes/session.mjs findSession) and the
		// admin plugin that would enforce `banned` is deliberately not loaded
		// (see the "No plugins" note on the config above). The SPA's RequireAuth
		// polls exactly this endpoint, so without this gate a banned user's
		// browser keeps a live session until the cookie expires. The app's own
		// endpoints (/api/pages/*, /api/admin/*) already go through
		// getSessionUser, which carries the same check.
		if (req.originalUrl.replace(/^\/api\/auth/, '') === '/get-session' && webRes.status === 200) {
			const payload = await webRes.json().catch(() => null);
			if (payload?.user) {
				const [row] = await db
					.select({ banned: user.banned, banExpires: user.banExpires })
					.from(user)
					.where(eq(user.id, payload.user.id))
					.limit(1);
				if (row?.banned && !(row.banExpires && row.banExpires.getTime() < Date.now())) {
					return res.status(401).json(null);
				}
			} else if (/session_token=/.test(req.headers.cookie ?? '')) {
				// A cookie was presented but the session row is gone (revoked by a
				// ban, expired, or forged). better-auth answers `null` with a 200
				// here; 401 is the honest answer to a credential that no longer
				// authenticates, and the SPA's getSession() already treats any
				// non-2xx as "logged out".
				return res.status(401).json(null);
			}
			const body = JSON.stringify(payload);
			res.status(200);
			for (const [k, v] of webRes.headers) {
				if (k.toLowerCase() === 'set-cookie') continue;
				res.setHeader(k, v);
			}
			const cookies = typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
			for (const c of cookies) res.append('Set-Cookie', c);
			return res.send(body);
		}
		res.status(webRes.status);
		webRes.headers.forEach((v, k) => {
			if (k.toLowerCase() === 'set-cookie') return;
			res.setHeader(k, v);
		});
		const cookies = typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
		for (const c of cookies) res.append('Set-Cookie', c);
		res.send(Buffer.from(await webRes.arrayBuffer()));
	} catch (err) {
		console.error('[auth]', err);
		res.status(500).json({ error: 'Authentication service unavailable' });
	}
});

app.use(express.json({ limit: '1mb' }));
// Malformed JSON otherwise reaches Express's default HTML error page (with a
// stack trace when NODE_ENV is unset). API callers get JSON, never HTML.
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const status = err && typeof err.status === 'number' ? err.status : 400;
    return res.status(status).json({ error: 'Invalid request body' });
  }
  next(err);
});

// Rate limiting for the authenticated surfaces: keyed on the session user id
// when one is present, else the real client IP, so shared NATs count together.
const _limitKey = async (req) => {
  try { const u = await getSessionUser(req); if (u?.id) return `u:${u.id}`; } catch {}
  return _ipKey(req);
};
// Public read surfaces are DB-backed aggregates; cap them per IP so one client
// cannot amplify into Postgres unbounded. Generous ceiling: normal browsing
// never approaches it.
const _publicRead = rateLimit({ windowMs: 60_000, max: 600, key: _ipKey });
app.use('/api/models', _publicRead);
app.use('/api/providers', _publicRead);
app.use('/api/pricing', _publicRead);
app.use('/api/metrics', _publicRead);
app.use('/api/status', _publicRead);
app.use('/api/docs', _publicRead);
app.use('/api/changelog', _publicRead);
app.use('/api/palette', _publicRead);
app.use('/api/pages', rateLimit({ windowMs: 60_000, max: 300, key: _limitKey }));
app.use('/api/admin', rateLimit({ windowMs: 60_000, max: 300, key: _limitKey }));
app.use('/api/playground', rateLimit({ windowMs: 60_000, max: 10, key: _limitKey }));
async function authedUser(req) {
	return getSessionUser(req);
}

const PALETTE_TYPES = ['keys', 'models', 'providers', 'requests'];

app.get('/api/palette/:type', async (req, res) => {
	try {
		if (!PALETTE_TYPES.includes(req.params.type)) {
			return res.status(404).json({ error: 'Unknown palette type' });
		}
		const database = needDb(res);
		if (!database) return;
		const userRow = await authedUser(req);
		requireCap(userRow, 'member');
		const url = new URL(req.originalUrl, 'http://localhost');
		const { q, limit } = paletteParams(url);
		const pattern = likePattern(q);

		if (req.params.type === 'keys') {
			const rows = await database
				.select({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix, status: apiKey.status })
				.from(apiKey)
				.where(
					and(
						eq(apiKey.userId, userRow.id),
						sql`(${apiKey.policy} ->> 'playground') is distinct from 'true'`,
						q ? sql`${apiKey.name} ilike ${pattern} or ${apiKey.prefix} ilike ${pattern}` : sql`true`
					)
				)
				.orderBy(apiKey.createdAt)
				.limit(limit);
			return res.json({
				items: rows.map((r) => ({
					id: r.id,
					type: 'key',
					title: r.name,
					subtitle: `${r.prefix}… · ${r.status}`,
					href: '/dashboard/keys'
				}))
			});
		}
		if (req.params.type === 'providers') {
			const rows = await database
				.select({ id: provider.id, name: provider.name, slug: provider.slug })
				.from(provider)
				.where(q ? sql`${provider.name} ilike ${pattern} or ${provider.slug} ilike ${pattern}` : sql`true`)
				.orderBy(provider.name)
				.limit(limit);
			return res.json({
				items: rows.map((r) => ({
					id: r.id,
					type: 'provider',
					title: r.name,
					subtitle: r.slug ?? '',
					// /pricing is the only public catalogue page left. This used
					// to point at /models, and then at /providers, and both are
					// withdrawn — a search hit that navigates to a 404 is worse
					// than no result, so the target moves with the public surface.
					href: '/pricing'
				}))
			});
		}
		if (req.params.type === 'models') {
			const rows = await database
				.select({ id: model.id, slug: model.slug, name: model.name, developer: model.developer })
				.from(model)
				.where(
					sql`${model.status} = 'active' and ${
						q
							? sql`${model.slug} ilike ${pattern} or ${model.name} ilike ${pattern} or ${model.developer} ilike ${pattern}`
							: sql`true`
					}`
				)
				.orderBy(model.slug)
				.limit(limit);
			return res.json({
				items: rows.map((r) => ({
					id: r.id,
					type: 'model',
					title: r.slug,
					subtitle: r.developer ? `${r.name} · ${r.developer}` : r.name,
					href: '/pricing'
				}))
			});
		}
		// requests
		if (q.length < 3) return res.json({ items: [] });
		const prefix = likePattern(q, 'prefix');
		// The query is bound to the CALLER's account, not just to a permission:
		// without the predicate below this returned every tenant's request ids
		// (with status, endpoint and createdAt), because the only filter was an id
		// prefix — and a uuidv7 id is timestamp-prefixed, so the leading
		// characters a caller must guess are enumerable.
		//
		// The builder, not raw SQL: `database.execute` returns the driver's
		// RowList (snake_case) while the response mapping below reads camelCase
		// properties, so raw SQL here silently yields undefined fields.
		const rows = await database
			.select({
				id: requestLog.id,
				status: requestLog.status,
				endpoint: requestLog.endpoint,
				createdAt: requestLog.createdAt
			})
			.from(requestLog)
			.where(and(sql`${requestLog.id} ilike ${prefix}`, eq(requestLog.userId, userRow.id)))
			.orderBy(desc(requestLog.createdAt))
			.limit(limit);
		return res.json({
			items: rows.map((r) => ({
				id: r.id,
				type: 'request',
				title: r.id,
				subtitle: `${r.status} · ${r.endpoint ?? '—'}`,
				href: '/dashboard/usage'
			}))
		});
	} catch (err) {
		if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
		console.error('[palette]', err);
		return res.status(500).json({ error: 'Palette lookup failed' });
	}
});

// ------------------------------------------------------------ page loads ----
// The shell used to return the workspace/project/environment tree plus three
// selection cookies (fwid/fpid/feid). With the hierarchy gone (migration 0019)
// there is nothing to switch between: the account IS the tenant. What remains is
// the idempotent account provisioning, so a user who signed up before the
// flatten still gets a billing account on first load.
app.get('/api/pages/shell', async (req, res) => {
	try {
		const database = needDb(res);
		if (!database) return;
		const userRow = await authedUser(req);
		requireCap(userRow, 'member');
		const { billingAccountId } = await ensureUserAccount(database, {
			userId: userRow.id,
			ip: clientIp(req)
		});
		return res.json({ shell: { userId: userRow.id, billingAccountId } });
	} catch (err) {
		if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
		console.error('[pages/shell]', err);
		return res.status(500).json({ error: 'Shell load failed' });
	}
});

// Key page load lives in pages.mjs. There used to be a second, inline
// GET /api/pages/{dashboard/,}keys here returning only the raw columns.
// Express serves the FIRST registered match, and this one was registered
// before registerPages, so it shadowed the complete handler: the response
// carried no usage30d/projectName/expiresAt, and KeysPage dereferences
// k.usage30d.requests, so /dashboard/keys threw on every load.

registerPlayground(app, {
	needDb,
	authedUser,
	requireCap,
	HttpError,
	eq,
	newId,
	ID_PREFIXES,
	writeAudit,
	client
});

registerAdminRoutes(app, { needDb, authedUser, requireCap, HttpError });
registerPages(app, { getDb: () => db, needDb, authedUser, requireCap, parseCookies, newId, writeAudit, ID_PREFIXES, HttpError });
registerPublicRoutes(app, { needDb, HttpError });

// Unknown page APIs are a contract break (typo, removed endpoint): 404 + log,
// never a silent 200 {empty:true} that the client renders as an empty state.
app.get('/api/pages/{*path}', (req, res) => {
  console.warn('[pages] unknown endpoint', req.path);
  res.status(404).json({ error: 'Unknown endpoint' });
});

// Crawler files must precede the SPA fallback, which would otherwise serve
// index.html with a 200 for these paths.
//
// The sitemap is built from the SEO registry (src/lib/seo.ts), not a literal
// list: the old hardcoded SITE_ROUTES drifted the moment a route was added, and
// it could not carry a priority or a change frequency. The registry is the same
// table the head renderer below and the SPA's Meta component read, so all three
// agree by construction.
app.get('/robots.txt', (req, res) => {
  // requestOrigin, not req.protocol: the tunnel terminates TLS and caddy dials
  // this server in plaintext, so req.protocol alone is 'http' and the Sitemap
  // line advertised an HSTS redirect. See lib/ip.mjs.
  const origin = requestOrigin(req);
  // The Disallow list is not decoration: the SPA fallback below 303-redirects
  // /dashboard*, /admin* and /invite* to /login for an anonymous request
  // (index.mjs:989-993, verified live), so allowing them spends crawl budget on
  // redirects. Paths are written WITHOUT a trailing slash on purpose: robots
  // matching is a literal prefix compare, so `Disallow: /dashboard/` would not
  // block the exact URL `/dashboard`, which is one of the gated ones.
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /admin\nDisallow: /invite\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`
  );
});
app.get('/sitemap.xml', (req, res) => {
  const origin = requestOrigin(req);
  // lastmod is the deploy's own build time, not "now": a sitemap that claims
  // every URL changed on every crawl is the signal crawlers learn to ignore.
  const lastmod = new Date(BUILD_TIME).toISOString().slice(0, 10);
  const urls = seo
    .sitemapPaths()
    .map((p) => {
      const meta = seo.seoFor(p);
      const hints = [
        meta.changefreq ? `<changefreq>${meta.changefreq}</changefreq>` : '',
        meta.priority !== undefined ? `<priority>${meta.priority.toFixed(1)}</priority>` : '',
      ]
        .filter(Boolean)
        .join('');
      return `  <url><loc>${origin}${p === '/' ? '/' : p}</loc><lastmod>${lastmod}</lastmod>${hints}</url>`;
    })
    .join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

// --- static React build ---
// Hashed /assets/* files are content-addressed: immutable 1y. index.html itself
// is NOT served statically — a static index.html answers `/` with the shell's
// own landing-page tags and skips the head rewrite below, which is exactly what
// happened before this (curl / returned the static title and no robots tag, with
// the correct one only on /models). The SPA fallback serves every page path, so
// there is one code path that produces HTML.
app.use('/assets', express.static(path.join(DIST, 'assets'), { maxAge: '1y', immutable: true }));
// The link-preview card and the app icons, from the DURABLE (non-hashed) static
// directory. They cannot live under /assets: a social scraper will not run the
// SPA, so the URL in og:image has to resolve on its own, and a content-hashed
// filename would change under every crawler that had cached the old one. Without
// this mount the request falls through to the SPA fallback below and answers a
// scraper with HTML where it asked for an image, which is a broken preview.
//
// A day of max-age is the compromise: long enough not to re-fetch per preview,
// short enough that a rebrand is visible within a day.
app.use(
	express.static(path.join(__dirname, '..', 'public'), {
		maxAge: '1d',
		index: false,
		fallthrough: true,
		setHeaders: (res, filePath) => {
			// og.png is opaque and only ever embedded; the icons are small.
			if (filePath.endsWith('.png')) res.type('image/png');
		},
	})
);
app.get('{*path}', async (req, res, next) => {
	if (req.path.startsWith('/api/')) return next();
	const p = req.path;
	if (p === '/dashboard' || p.startsWith('/dashboard/') || p === '/admin' || p.startsWith('/admin/') || p.startsWith('/invite/')) {
		try {
			const u = await getSessionUser(req);
			if (!u) return res.redirect(303, '/login');
		} catch { return res.redirect(303, '/login'); }
	}
	// The shell is the landing page's. Rewriting its head per request is what
	// makes /pricing answer with its own title, description and canonical
	// instead of the landing page's — before this, every public route served
	// `<title>FUDRouter — one API key, every model</title>` and a canonical to
	// `/`, which is a duplicate-content signal against the homepage.
	const shell = readShell(DIST);
	if (shell === null) {
		// No build on disk (a bare `npm run server`). The head cannot be
		// rewritten, but the status still must not lie about a known route
		// being missing — fall through to the old sendFile path and let Express
		// answer.
		return res.sendFile(path.join(DIST, 'index.html'));
	}
	// A path no route serves is a 404, not a 200 with the shell. The SPA still
	// renders its NotFound page (the body is unchanged), but the status and the
	// noindex tag tell a crawler the truth: there is nothing here to index.
	// Before this, /nonsense answered 200 — a soft 404 a crawler indexes.
	const status = seo.isKnownRoute(p) ? 200 : 404;
	res.status(status).type('html').send(withHead(shell, p, requestOrigin(req)));
});

const PORT = process.env.PORT || 3000;
// Bind loopback only (caddy reaches it at 127.0.0.1:3002). The default `::` bind
// exposed the control plane on the LAN, against the box's loopback-only rule.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`fudrouter-console listening on ${HOST}:${PORT}`));
