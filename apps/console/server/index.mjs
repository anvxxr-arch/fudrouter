import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { uuidv7 } from 'uuidv7';
import { registerPlayground } from './playground.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { registerPages } from './pages.mjs';
import { registerPublicRoutes } from './public.mjs';
import { rateLimit } from './rate-limit.mjs';
import { clientIp } from './lib/ip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

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
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const workspace = pgTable('workspace', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	ownerUserId: text('owner_user_id'),
	status: text('status').notNull().default('active')
});
export const workspaceRole = pgTable('workspace_role', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id'),
	name: text('name').notNull(),
	permissions: jsonb('permissions').$type().notNull().default([])
});
export const workspaceMember = pgTable('workspace_member', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id').notNull(),
	userId: text('user_id').notNull(),
	roleId: text('role_id').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const project = pgTable('project', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id').notNull(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const environment = pgTable('environment', {
	id: text('id').primaryKey(),
	projectId: text('project_id').notNull(),
	name: text('name').notNull(),
	slug: text('slug').notNull(),
	type: text('type').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const billingAccount = pgTable('billing_account', {
	id: text('id').primaryKey(),
	workspaceId: text('workspace_id').notNull()
});
export const auditLog = pgTable('audit_log', {
	id: text('id').primaryKey(),
	actorUserId: text('actor_user_id'),
	actorKind: text('actor_kind').notNull().default('user'),
	action: text('action').notNull(),
	resource: text('resource').notNull(),
	resourceId: text('resource_id'),
	workspaceId: text('workspace_id'),
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
				workspace,
				workspaceRole,
				workspaceMember,
				project,
				environment,
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
	workspace: 'wrk_',
	workspaceMember: 'mem_',
	workspaceRole: 'rol_',
	project: 'prj_',
	environment: 'env_',
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
		workspaceId: entry.workspaceId ?? null,
		ip: entry.ip ?? null,
		before: entry.before ? redactSecrets(entry.before) : null,
		after: entry.after ? redactSecrets(entry.after) : null,
		metadata: entry.metadata ? redactSecrets(entry.metadata) : {}
	});
}

// ------------------------------------------------------------ provision ----
function slugify(input) {
	const s = String(input)
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return s || 'workspace';
}
const DEFAULT_ENVIRONMENTS = [
	{ name: 'Development', slug: 'development', type: 'development' },
	{ name: 'Staging', slug: 'staging', type: 'staging' },
	{ name: 'Production', slug: 'production', type: 'production' }
];
async function createProject(dbtx, opts) {
	let slug = opts.slug ?? slugify(opts.name);
	for (let n = 2; ; n++) {
		const [taken] = await dbtx.select({ id: project.id }).from(project).where(eq(project.slug, slug)).limit(1);
		if (!taken) break;
		slug = `${slugify(opts.name)}-${n}`;
	}
	const id = newId(ID_PREFIXES.project);
	await dbtx.insert(project).values({ id, workspaceId: opts.workspaceId, name: opts.name, slug });
	for (const e of DEFAULT_ENVIRONMENTS) {
		await dbtx.insert(environment).values({ id: newId(ID_PREFIXES.environment), projectId: id, ...e });
	}
	return { id, slug };
}
async function provisionWorkspace(dbtx, opts) {
	let slug = opts.slug ?? slugify(opts.name);
	for (let n = 2; ; n++) {
		const [taken] = await dbtx.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, slug)).limit(1);
		if (!taken) break;
		slug = `${slugify(opts.name)}-${n}`;
	}
	const workspaceId = newId(ID_PREFIXES.workspace);
	await dbtx.insert(workspace).values({ id: workspaceId, name: opts.name, slug, ownerUserId: opts.ownerUserId });
	const ownerRole = await dbtx
		.select({ id: workspaceRole.id })
		.from(workspaceRole)
		.where(sql`${workspaceRole.workspaceId} IS NULL AND ${workspaceRole.name} = 'owner'`)
		.limit(1);
	if (!ownerRole.length) throw new Error('builtin owner workspace_role row is missing');
	const memberId = newId(ID_PREFIXES.workspaceMember);
	await dbtx.insert(workspaceMember).values({
		id: memberId,
		workspaceId,
		userId: opts.ownerUserId,
		roleId: ownerRole[0].id,
		status: 'active'
	});
	const { id: projectId } = await createProject(dbtx, {
		workspaceId,
		name: `${opts.name.split("'")[0]}'s Project`
	});
	const environmentIds = await dbtx
		.select({ id: environment.id })
		.from(environment)
		.where(eq(environment.projectId, projectId))
		.then((rows) => rows.map((r) => r.id));
	const billingAccountId = newId(ID_PREFIXES.billingAccount);
	await dbtx.insert(billingAccount).values({ id: billingAccountId, workspaceId });
	await writeAudit(dbtx, {
		actorUserId: opts.ownerUserId,
		action: 'workspace.create',
		resource: 'workspace',
		resourceId: workspaceId,
		workspaceId,
		ip: opts.ip ?? null,
		after: { name: opts.name, slug },
		metadata: { projectId, billingAccountId, environmentIds }
	});
	return { workspaceId, projectId, environmentIds, memberId, billingAccountId, slug };
}
async function ensureUserWorkspace(dbtx, opts) {
	const [existing] = await dbtx
		.select({ workspaceId: workspaceMember.workspaceId })
		.from(workspaceMember)
		.where(eq(workspaceMember.userId, opts.userId))
		.limit(1);
	if (existing) return { workspaceId: existing.workspaceId };
	const provisioned = await provisionWorkspace(dbtx, {
		name: `${opts.name.split("'")[0]}'s Workspace`,
		ownerUserId: opts.userId,
		ip: opts.ip ?? null
	});
	return { workspaceId: provisioned.workspaceId };
}

// ----------------------------------------------------------------- auth ----
const ORIGIN = process.env.ORIGIN || process.env.BETTER_AUTH_URL || 'http://localhost:3000';
const authSchema = { user, session, account, verification };
export const auth = betterAuth({
	baseURL: ORIGIN,
	secret: process.env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db ?? {}, { provider: 'pg', schema: authSchema }),
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
					if (!db) throw new Error('DATABASE_URL is not set; cannot provision workspace');
					await db.transaction(async (tx) => {
						await provisionWorkspace(tx, {
							name: `${created.name.split("'")[0]}'s Workspace`,
							ownerUserId: created.id
						});
					});
				}
			}
		}
	},
	trustedOrigins: process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'],
	emailAndPassword: { enabled: true },
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
						prompt: 'consent'
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
const ALL_WORKSPACE_PERMISSIONS = [
	'workspace.read', 'workspace.write', 'workspace.delete', 'member.read', 'member.invite',
	'member.remove', 'project.read', 'project.write', 'project.delete', 'key.read',
	'key.create', 'key.rotate', 'key.revoke', 'routing.read', 'routing.write', 'alias.read',
	'alias.write', 'request.read', 'analytics.read', 'usage.read', 'budget.read',
	'budget.write', 'limit.read', 'limit.write', 'alert.read', 'alert.write', 'webhook.read',
	'webhook.write', 'billing.read', 'billing.write'
];
function isWorkspacePermission(v) {
	return typeof v === 'string' && ALL_WORKSPACE_PERMISSIONS.includes(v);
}
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
	return data?.user ?? null;
}
async function memberContext(database, userId, workspaceId) {
	const [row] = await database
		.select({
			memberId: workspaceMember.id,
			memberRoleId: workspaceMember.roleId,
			memberStatus: workspaceMember.status,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			workspaceSlug: workspace.slug,
			workspaceOwnerUserId: workspace.ownerUserId,
			workspaceStatus: workspace.status,
			permissions: workspaceRole.permissions
		})
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.innerJoin(workspaceRole, eq(workspaceRole.id, workspaceMember.roleId))
		.where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
		.limit(1);
	if (!row) return null;
	return {
		member: { id: row.memberId, roleId: row.memberRoleId, status: row.memberStatus },
		workspace: {
			id: row.workspaceId,
			name: row.workspaceName,
			slug: row.workspaceSlug,
			ownerUserId: row.workspaceOwnerUserId,
			status: row.workspaceStatus
		},
		caps: new Set((row.permissions ?? []).filter(isWorkspacePermission))
	};
}
async function currentWorkspaceId(database, userId, cookies) {
	const wid = cookies.fwid;
	if (wid) {
		const [row] = await database
			.select({ id: workspaceMember.workspaceId })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, wid),
					eq(workspaceMember.userId, userId),
					eq(workspaceMember.status, 'active')
				)
			)
			.limit(1);
		if (row) return row.id;
	}
	const [first] = await database
		.select({ id: workspaceMember.workspaceId })
		.from(workspaceMember)
		.where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.status, 'active')))
		.orderBy(asc(workspaceMember.createdAt))
		.limit(1);
	return first?.id ?? null;
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
async function requireMemberPermission(database, userRow, workspaceId, perm) {
	if (!userRow) throw new HttpError(401, 'Authentication required');
	const ctx = await memberContext(database, userRow.id, workspaceId);
	if (!ctx || ctx.member.status !== 'active') throw new HttpError(403, 'Not a member of this workspace');
	if (!ctx.caps.has(perm)) throw new HttpError(403, 'Missing permission: ' + perm);
	return { member: ctx.member, workspace: ctx.workspace };
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
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const raw = chunks.length ? Buffer.concat(chunks) : null;
		const webReq = new Request(url, {
			method: req.method,
			headers,
			body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw,
			duplex: 'half'
		});
		const webRes = await auth.handler(webReq);
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

const PALETTE_TYPES = ['keys', 'models', 'providers', 'projects', 'requests', 'workspaces'];

app.get('/api/palette/:type', async (req, res) => {
	try {
		if (!PALETTE_TYPES.includes(req.params.type)) {
			return res.status(404).json({ error: 'Unknown palette type' });
		}
		const database = needDb(res);
		if (!database) return;
		const userRow = await authedUser(req);
		requireCap(userRow, 'member');
		const cookies = parseCookies(req);
		const url = new URL(req.originalUrl, 'http://localhost');
		const { q, limit } = paletteParams(url);
		const pattern = likePattern(q);

		if (req.params.type === 'keys') {
			const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
			if (!workspaceId) return res.json({ items: [] });
			await requireMemberPermission(database, userRow, workspaceId, 'key.read');
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
			const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
			if (!workspaceId) return res.json({ items: [] });
			await requireMemberPermission(database, userRow, workspaceId, 'workspace.read');
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
					href: '/models'
				}))
			});
		}
		if (req.params.type === 'models') {
			const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
			if (!workspaceId) return res.json({ items: [] });
			await requireMemberPermission(database, userRow, workspaceId, 'workspace.read');
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
					href: '/models'
				}))
			});
		}
		if (req.params.type === 'projects') {
			const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
			if (!workspaceId) return res.json({ items: [] });
			await requireMemberPermission(database, userRow, workspaceId, 'project.read');
			const rows = await database
				.select({ id: project.id, name: project.name, slug: project.slug })
				.from(project)
				.where(
					and(
						eq(project.workspaceId, workspaceId),
						q ? sql`${project.name} ilike ${pattern} or ${project.slug} ilike ${pattern}` : sql`true`
					)
				)
				.orderBy(project.name)
				.limit(limit);
			return res.json({
				items: rows.map((r) => ({
					id: r.id,
					type: 'project',
					title: r.name,
					subtitle: r.slug,
					href: `/dashboard/projects/${r.id}`
				}))
			});
		}
		if (req.params.type === 'requests') {
			const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
			if (!workspaceId) return res.json({ items: [] });
			await requireMemberPermission(database, userRow, workspaceId, 'request.read');
			if (q.length < 3) return res.json({ items: [] });
			const prefix = likePattern(q, 'prefix');
			const rows = await database
				.select({
					id: requestLog.id,
					status: requestLog.status,
					endpoint: requestLog.endpoint,
					createdAt: requestLog.createdAt
				})
				.from(requestLog)
				.where(sql`${requestLog.id} ilike ${prefix}`)
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
		}
		// workspaces: memberships only.
		const rows = await database
			.select({ id: workspace.id, name: workspace.name, slug: workspace.slug })
			.from(workspaceMember)
			.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
			.where(
				and(
					eq(workspaceMember.userId, userRow.id),
					eq(workspaceMember.status, 'active'),
					q ? sql`${workspace.name} ilike ${pattern} or ${workspace.slug} ilike ${pattern}` : sql`true`
				)
			)
			.orderBy(workspace.name)
			.limit(limit);
		return res.json({
			items: rows.map((r) => ({
				id: r.id,
				type: 'workspace',
				title: r.name,
				subtitle: r.slug,
				href: '/dashboard/workspace'
			}))
		});
	} catch (err) {
		if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
		console.error('[palette]', err);
		return res.status(500).json({ error: 'Palette lookup failed' });
	}
});

// ------------------------------------------------------------ page loads ----
app.get('/api/pages/shell', async (req, res) => {
	try {
		const database = needDb(res);
		if (!database) return;
		const userRow = await authedUser(req);
		requireCap(userRow, 'member');
		const cookies = parseCookies(req);
		await ensureUserWorkspace(database, { userId: userRow.id, name: userRow.name, ip: clientIp(req) });
		const workspaces = await database
			.select({ id: workspace.id, name: workspace.name })
			.from(workspaceMember)
			.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
			.where(and(eq(workspaceMember.userId, userRow.id), eq(workspaceMember.status, 'active')));
		const workspaceId = await currentWorkspaceId(database, userRow.id, cookies);
		if (workspaceId && workspaceId !== cookies.fwid) {
			// httpOnly + secure: deployment is behind a cloudflared tunnel at
			// https://ai.karepmuwes.my.id, so this only ever travels over HTTPS.
			res.cookie('fwid', workspaceId, { path: '/', maxAge: 31536000000, sameSite: 'lax', httpOnly: true, secure: true });
		}
		const projects = workspaceId
			? await database
					.select({ id: project.id, name: project.name })
					.from(project)
					.where(and(eq(project.workspaceId, workspaceId), eq(project.status, 'active')))
					.orderBy(asc(project.createdAt))
			: [];
		const projectId = projects.some((p) => p.id === cookies.fpid)
			? cookies.fpid
			: (projects[0]?.id ?? null);
		const environments = projectId
			? await database
					.select({ id: environment.id, name: environment.name, slug: environment.slug })
					.from(environment)
					.where(and(eq(environment.projectId, projectId), eq(environment.status, 'active')))
					.orderBy(asc(environment.createdAt))
			: [];
		const environmentId = environments.some((e) => e.id === cookies.feid)
			? cookies.feid
			: (environments[0]?.id ?? null);
		return res.json({
			shell: { workspaces, workspaceId, projects, projectId, environments, environmentId }
		});
	} catch (err) {
		if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
		console.error('[pages/shell]', err);
		return res.status(500).json({ error: 'Shell load failed' });
	}
});

// Key page load (dashboard/keys).
app.get(['/api/pages/keys', '/api/pages/dashboard/keys'], async (req, res) => {
	try {
		const database = needDb(res);
		if (!database) return;
		const userRow = await authedUser(req);
		requireCap(userRow, 'member');
		const keys = await database
			.select({
				id: apiKey.id,
				name: apiKey.name,
				prefix: apiKey.prefix,
				status: apiKey.status,
				lastUsedAt: apiKey.lastUsedAt,
				revokedAt: apiKey.revokedAt,
				createdAt: apiKey.createdAt
			})
			.from(apiKey)
			.where(eq(apiKey.userId, userRow.id))
			.orderBy(desc(apiKey.createdAt));
		return res.json({ keys });
	} catch (err) {
		if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
		console.error('[pages/keys]', err);
		return res.status(500).json({ error: 'Keys load failed' });
	}
});

registerPlayground(app, {
	needDb,
	authedUser,
	parseCookies,
	currentWorkspaceId,
	requireMemberPermission,
	requireCap,
	HttpError,
	provider,
	environment,
	project,
	eq,
	and,
	newId,
	ID_PREFIXES,
	writeAudit,
	client
});

registerAdminRoutes(app, { needDb, authedUser, requireCap, HttpError });
registerPages(app, { getDb: () => db, needDb, authedUser, requireCap, requireMemberPermission, currentWorkspaceId, parseCookies, newId, writeAudit, ID_PREFIXES, HttpError });
registerPublicRoutes(app, { needDb, HttpError });

// Unknown page APIs are a contract break (typo, removed endpoint): 404 + log,
// never a silent 200 {empty:true} that the client renders as an empty state.
app.get('/api/pages/{*path}', (req, res) => {
  console.warn('[pages] unknown endpoint', req.path);
  res.status(404).json({ error: 'Unknown endpoint' });
});

// Crawler files must precede the SPA fallback, which would otherwise serve
// index.html with a 200 for these paths.
const SITE_ROUTES = ['', '/models', '/providers', '/pricing', '/playground', '/docs', '/status', '/changelog', '/login', '/signup'];
app.get('/robots.txt', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const urls = SITE_ROUTES.map((r) => `  <url><loc>${origin}${r || '/'}</loc></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
});

// --- static React build ---
// Hashed /assets/* files are content-addressed: immutable 1y. index.html and
// all other paths keep the default (revalidate) so deploys take effect.
app.use('/assets', express.static(path.join(DIST, 'assets'), { maxAge: '1y', immutable: true }));
app.use(express.static(DIST));
app.get('{*path}', async (req, res, next) => {
	if (req.path.startsWith('/api/')) return next();
	const p = req.path;
	if (p === '/dashboard' || p.startsWith('/dashboard/') || p === '/admin' || p.startsWith('/admin/') || p.startsWith('/invite/')) {
		try {
			const u = await getSessionUser(req);
			if (!u) return res.redirect(303, '/login');
		} catch { return res.redirect(303, '/login'); }
	}
	res.sendFile(path.join(DIST, 'index.html'));
});

const PORT = process.env.PORT || 3000;
// Bind loopback only (caddy reaches it at 127.0.0.1:3002). The default `::` bind
// exposed the control plane on the LAN, against the box's loopback-only rule.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`fudrouter-console listening on ${HOST}:${PORT}`));
