# S0-B — Schema, Auth, API Keys & Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the S0 walking skeleton end-to-end: 9-table Postgres schema, Better Auth with RBAC, hash-only API keys, AES-256-GCM provider credentials, a Go data plane serving `/v1/chat/completions` with request logging, and a usage page — proven by one E2E smoke test.

**Architecture:** SvelteKit control plane (`apps/web`) owns auth, keys, and pages; Go data plane (`services/router`) owns the hot path, reading `api_key`/`model`/`provider` directly from Postgres and writing `request_log`. Provider credentials are AES-256-GCM encrypted at rest, decrypted only inside the Go process. Money is int64 micro-units end to end.

**Tech Stack:** SvelteKit 2 + Svelte 5, Drizzle ORM, Better Auth (admin plugin), Postgres 17, Go 1.23 + pgx/v5, Vitest, PM2.

**Spec:** `docs/specs/2026-09-21-s0-foundation-design.md` (§7 data model, §8 auth/RBAC, §9 API keys, §10 credentials, §11 walking skeleton, §12 testing, §13 deploy)

## Global Constraints

- Repo root: `/home/dwizzy/fudrouter`, branch off `master` (currently `413a1fc`)
- **Money is never a float**: prices `numeric(12,6)` = **minor currency units per 1M tokens** (e.g. USD $0.15/1M input → `150000.000000` micro-USD); amounts `bigint` micro-units; every monetary row carries `currency char(3)`. All arithmetic in int64/BigInt. Float only ever renders for display.
- **API keys are hash-only**: format `sk-ar-<prefix>_<secret>`; store SHA-256(secret) hex + plaintext prefix; constant-time compare; shown exactly once.
- **Provider credentials AES-256-GCM at rest**: wire format `base64(iv[12] || ciphertext || tag[16])`; master key = `CREDENTIALS_MASTER_KEY` (32 bytes base64) from env; plaintext never returned by any API, never logged.
- **Migrations are Drizzle Kit SQL files** in `infra/migrations` — never `drizzle-kit push` against a database that matters.
- IDs: UUIDv7 text, generated app-side (TS `uuidv7` pkg; Go `gofrs/uuid` NewV7). Better Auth keeps its own id format.
- Ports: web `3000`, router `8100`, dev PG `5434`, Valkey `6379`. Never bind `8011 8012 443 5432 5433 8080 8443 9177`.
- PM2 names: `fudrouter-web`, `fudrouter-router`.
- ⚠️ **`NODE_ENV=production` is exported in the controller shell** — every `npm install`/`npm ci`/`npx` that installs MUST be prefixed `NODE_ENV=development` or node_modules silently empties. `npm run check/test/build` are safe as-is.
- Dev stack is live: `fudrouter-db` (PG 17) on `127.0.0.1:5434`, `fudrouter-cache` (Valkey) on `127.0.0.1:6379`. DB user/pass/name all `fudrouter`.
- Display-masking trap: password-like strings (e.g. `fudrouter:fudrouter@`) may RENDER as `***` in tool output. Verify bytes with `xxd`/`.hex()` before believing a value is wrong.

## Review Focus

Failure modes this plan's tasks must not leave open — each pinned by a test in the owning task:

1. **Key validation must be constant-time and reject bad/revoked keys** — wrong secret, malformed key, unknown prefix, and revoked key all → 401 (pinned in Task 5 `keys_test.go` + `proxy_test.go`).
2. **Money math must be exact integers** — 1000 tokens × 150000 micro/1M = exactly 150 micro, no float anywhere (pinned in Task 5 `cost_test.go` with exact expected int64s).
3. **SSE stream must pass through uncorrupted with usage captured** — chunk order preserved, `data: [DONE]` forwarded, usage from the final chunk recorded (pinned in Task 5 `proxy_test.go` against an httptest upstream).
4. **Credential plaintext must never leak** — decrypt failure responses carry no plaintext; logs never contain it (pinned in Task 4 `credentials.test.ts` round-trip + Task 5 error-path test).
5. **Schema migration must be clean and complete** — 9 tables + 3 request_log indexes exist after migrate on a fresh database (pinned in Task 1 verification against a scratch database).

---

## Ruling: no key-lookup cache in S0-B

Spec §9 describes an in-process `prefix → (userId, keyHash, limits)` cache with short TTL. S0-B implements **direct PG read per request** instead: correct-by-construction, ~1ms on local PG, no revoke-invalidation problem. The cache (and the §7 `<50ms` budget it serves) belongs to S1 router-core work. Recorded here so reviewers don't flag its absence.

---

## Task 1: Schema — 9 tables + migrations in `infra/migrations`

**Files:**
- Modify: `apps/web/src/lib/server/auth.ts` (add admin plugin)
- Create: `apps/web/src/lib/server/db/schema.ts` (replace demo `task` table)
- Regenerate: `apps/web/src/lib/server/db/auth.schema.ts` (via `auth:schema`)
- Modify: `apps/web/drizzle.config.ts` (out → `../../infra/migrations`)
- Delete: `apps/web/src/routes/demo/**` (5 files)
- Create: `infra/migrations/*` (generated SQL)

**Interfaces:**
- Consumes: live dev PG on `127.0.0.1:5434` (db/user/pass `fudrouter`)
- Produces: tables `user, session, account, verification, profile, api_key, provider, model, request_log`; migration SQL checked into `infra/migrations`; `db:check`/`db:migrate` scripts

- [ ] **Step 1: Add the Better Auth admin plugin (supplies role/banned/banReason/banExpires/impersonatedBy)**

`apps/web/src/lib/server/auth.ts` — full replacement:

```ts
import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { admin } from 'better-auth/plugins';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';

export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: { enabled: true },
	plugins: [
		admin({
			defaultRole: 'user'
		}),
		sveltekitCookies(getRequestEvent) // must be the last plugin in the array
	]
});
```

- [ ] **Step 2: Point drizzle-kit at `infra/migrations`**

`apps/web/drizzle.config.ts` — full replacement:

```ts
import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: '../../infra/migrations',
	dialect: 'postgresql',
	dbCredentials: { url: process.env.DATABASE_URL },
	verbose: true,
	strict: true
});
```

- [ ] **Step 3: Replace the demo schema with the 5 application tables**

`apps/web/src/lib/server/db/schema.ts` — full replacement:

```ts
import {
	pgTable,
	text,
	timestamp,
	jsonb,
	integer,
	bigint,
	numeric,
	char,
	index,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

// profile — 1:1 with Better Auth user
export const profile = pgTable('profile', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	avatar: text('avatar'),
	timezone: text('timezone'),
	preferences: jsonb('preferences').$type<Record<string, unknown>>().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// api_key — hash-only. `prefix` is indexed for lookup; `keyHash` = sha256(secret) hex.
export const apiKey = pgTable(
	'api_key',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		prefix: text('prefix').notNull(),
		keyHash: text('key_hash').notNull(),
		limits: jsonb('limits').$type<Record<string, unknown>>().notNull().default({}),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('api_key_prefix_idx').on(t.prefix),
		index('api_key_user_idx').on(t.userId)
	]
);

// provider — credentialsEnc = base64(iv[12]||ct||tag[16]), AES-256-GCM
export const provider = pgTable('provider', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	baseUrl: text('base_url').notNull(),
	credentialsEnc: text('credentials_enc').notNull(),
	status: text('status').notNull().default('active'),
	priority: integer('priority').notNull().default(100),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// model — prices are MINOR UNITS PER 1M TOKENS, numeric(12,6).
// e.g. USD $0.15 per 1M input tokens -> inputPrice '150000.000000' (micro-USD).
export const model = pgTable(
	'model',
	{
		id: text('id').primaryKey(),
		providerId: text('provider_id')
			.notNull()
			.references(() => provider.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		slug: text('slug').notNull(),
		context: integer('context'),
		inputPrice: numeric('input_price', { precision: 12, scale: 6 }).notNull(),
		outputPrice: numeric('output_price', { precision: 12, scale: 6 }).notNull(),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		status: text('status').notNull().default('active'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [uniqueIndex('model_slug_idx').on(t.slug)]
);

// request_log — append-only, highest-volume table. cost = micro-units of currency.
export const requestLog = pgTable(
	'request_log',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		apiKeyId: text('api_key_id')
			.notNull()
			.references(() => apiKey.id, { onDelete: 'cascade' }),
		modelId: text('model_id')
			.notNull()
			.references(() => model.id),
		providerId: text('provider_id')
			.notNull()
			.references(() => provider.id),
		tokensIn: integer('tokens_in').notNull().default(0),
		tokensOut: integer('tokens_out').notNull().default(0),
		cost: bigint('cost', { mode: 'bigint' }).notNull().default(0),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		latencyMs: integer('latency_ms').notNull().default(0),
		status: text('status').notNull(),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('request_log_user_created_idx').on(t.userId, t.createdAt),
		index('request_log_api_key_created_idx').on(t.apiKeyId, t.createdAt)
	]
);
```

- [ ] **Step 4: Regenerate the Better Auth schema (now includes admin fields)**

```bash
cd /home/dwizzy/fudrouter/apps/web
NODE_ENV=development npm run auth:schema
```
Expected: `src/lib/server/db/auth.schema.ts` regenerated, containing `role`, `banned`, `banReason`, `banExpires` on `user` and `impersonatedBy` on `session`.

- [ ] **Step 5: Delete the demo routes**

```bash
cd /home/dwizzy/fudrouter
rm -rf apps/web/src/routes/demo
```

- [ ] **Step 6: Generate the migration**

```bash
cd /home/dwizzy/fudrouter/apps/web
NODE_ENV=development npx drizzle-kit generate
```
Expected: new SQL file(s) under `/home/dwizzy/fudrouter/infra/migrations/` creating 9 tables + indexes. **Read the generated SQL** — it must contain `CREATE TABLE "user"`, `"session"`, `"account"`, `"verification"`, `"profile"`, `"api_key"`, `"provider"`, `"model"`, `"request_log"` and the three `request_log` indexes.

- [ ] **Step 7: Apply to the dev database and verify**

```bash
cd /home/dwizzy/fudrouter/apps/web
NODE_ENV=development npm run db:migrate
docker exec fudrouter-db psql -U fudrouter -d fudrouter -tAc "select tablename from pg_tables where schemaname='public' order by tablename;"
```
Expected: 9 tables listed (`account, api_key, model, profile, provider, request_log, session, user, verification`).

- [ ] **Step 8: Fresh-database proof (Review Focus 5)**

```bash
docker exec fudrouter-db psql -U fudrouter -d fudrouter -c "create database fudrouter_scratch;"
cd /home/dwizzy/fudrouter/apps/web
DATABASE_URL=postgres://fudrouter:fudrouter@127.0.0.1:5434/fudrouter_scratch NODE_ENV=development npm run db:migrate
docker exec fudrouter-db psql -U fudrouter -d fudrouter_scratch -tAc "select count(*) from pg_tables where schemaname='public';"
docker exec fudrouter-db psql -U fudrouter -d fudrouter -c "drop database fudrouter_scratch;"
```
Expected: count `9`, then scratch dropped. (If password renders masked in output, trust the exit code — see Global Constraints masking note.)

- [ ] **Step 9: check + commit**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run check
cd /home/dwizzy/fudrouter
git add apps/web infra/migrations
git commit -m "feat(db): 9-table schema with drizzle migrations in infra/migrations"
```
Expected: `svelte-check found 0 errors and 0 warnings`.

---

## Task 2: Auth pages + RBAC plumbing

**Files:**
- Modify: `apps/web/src/app.d.ts`
- Modify: `apps/web/src/hooks.server.ts`
- Create: `apps/web/src/routes/+layout.server.ts`
- Modify: `apps/web/src/routes/+layout.svelte`
- Create: `apps/web/src/routes/signup/+page.svelte`, `apps/web/src/routes/signup/+page.server.ts`
- Create: `apps/web/src/routes/login/+page.svelte`, `apps/web/src/routes/login/+page.server.ts`

**Interfaces:**
- Consumes: `auth` from Task 1 (with admin plugin)
- Produces: `locals.user` (with `role`), `locals.session`; routes `/login`, `/signup`; guard behavior: `/keys`, `/usage`, `/admin/*` require a session, `/admin/*` additionally requires `role === 'admin'`

- [ ] **Step 1: Type the locals**

`apps/web/src/app.d.ts` — full replacement:

```ts
import type { auth } from '$lib/server/auth';

type Session = typeof auth.$Infer.Session;

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
		interface Locals {
			user: Session['user'] | null;
			session: Session['session'] | null;
		}
	}
}

export {};
```

- [ ] **Step 2: Session guard in hooks**

`apps/web/src/hooks.server.ts` — full replacement:

```ts
import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';

const PROTECTED = ['/keys', '/usage', '/admin'];
const ADMIN_ONLY = ['/admin'];

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	const path = event.url.pathname;
	if (!building && PROTECTED.some((p) => path.startsWith(p)) && !event.locals.user) {
		redirect(303, '/login');
	}
	if (!building && ADMIN_ONLY.some((p) => path.startsWith(p))) {
		const role = event.locals.user?.role;
		if (role !== 'admin') {
			// Not a security boundary — the Go data plane re-enforces roles.
			redirect(303, '/login');
		}
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
```

- [ ] **Step 3: Layout data + nav**

`apps/web/src/routes/+layout.server.ts` — create:

```ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user
			? { name: locals.user.name, email: locals.user.email, role: locals.user.role }
			: null
	};
};
```

`apps/web/src/routes/+layout.svelte` — full replacement:

```svelte
<script lang="ts">
	import '../layout.css';
	let { data, children } = $props();

	async function logout() {
		const { signOut } = await import('$lib/server/auth').then((m) => ({
			signOut: m.auth.api.signOut
		}));
		await signOut({ headers: new Headers() });
		location.href = '/login';
	}
</script>

<nav class="nav">
	<a href="/">fudrouter</a>
	{#if data.user}
		<a href="/keys">API Keys</a>
		<a href="/usage">Usage</a>
		<span>{data.user.email} ({data.user.role})</span>
		<button onclick={logout}>Sign out</button>
	{:else}
		<a href="/login">Login</a>
		<a href="/signup">Sign up</a>
	{/if}
</nav>

<main>
	{@render children()}
</main>

<style>
	.nav {
		display: flex;
		gap: 1rem;
		align-items: center;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #333;
	}
	.nav span {
		margin-left: auto;
		opacity: 0.7;
	}
</style>
```

- [ ] **Step 4: Signup page**

`apps/web/src/routes/signup/+page.server.ts`:

```ts
import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');
		const name = String(form.get('name') ?? '');

		const res = await auth.api.signUpEmail({
			body: { email, password, name, callbackURL: '/' }
		});

		if (!res.ok) {
			return fail(400, { error: 'Signup failed — email already registered or invalid input' });
		}
		redirect(303, '/keys');
	}
};
```

`apps/web/src/routes/signup/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
</script>

<h1>Sign up</h1>
{#if form?.error}<p class="error">{form.error}</p>{/if}
<form method="POST" use:enhance>
	<label>Name <input name="name" required /></label>
	<label>Email <input name="email" type="email" required /></label>
	<label>Password <input name="password" type="password" minlength="8" required /></label>
	<button type="submit">Create account</button>
</form>
<p><a href="/login">Already have an account? Log in</a></p>
```

- [ ] **Step 5: Login page**

`apps/web/src/routes/login/+page.server.ts`:

```ts
import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { auth } from '$lib/server/auth';

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');

		const res = await auth.api.signInEmail({
			body: { email, password, callbackURL: '/' }
		});

		if (!res.ok) {
			return fail(400, { error: 'Invalid email or password' });
		}
		redirect(303, '/keys');
	}
};
```

`apps/web/src/routes/login/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
</script>

<h1>Log in</h1>
{#if form?.error}<p class="error">{form.error}</p>{/if}
<form method="POST" use:enhance>
	<label>Email <input name="email" type="email" required /></label>
	<label>Password <input name="password" type="password" required /></label>
	<button type="submit">Log in</button>
</form>
<p><a href="/signup">Need an account? Sign up</a></p>
```

- [ ] **Step 6: check + build + manual guard proof + commit**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run check && npm run build
```
Expected: 0 errors; build exit 0.

Guard proof (dev server, run in background, then curl):
```bash
cd /home/dwizzy/fudrouter/apps/web
(npm run dev -- --port 5199 >/tmp/dev.log 2>&1 &) ; sleep 5
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:5199/keys
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5199/login
pkill -f 'vite dev.*5199' || true
```
Expected: first line `303 .../login` (redirect — guard works), second line `200`.

```bash
cd /home/dwizzy/fudrouter
git add apps/web
git commit -m "feat(auth): login/signup pages, session guard, role plumbing"
```

---

## Task 3: API keys — generation, /keys page, revoke

**Files:**
- Create: `apps/web/src/lib/server/keys.ts`
- Create: `apps/web/src/lib/server/keys.test.ts`
- Create: `apps/web/src/routes/keys/+page.server.ts`, `apps/web/src/routes/keys/+page.svelte`
- Modify: `apps/web/package.json` (add `uuidv7` devDep, `test:keys` script)

**Interfaces:**
- Consumes: `apiKey` table from Task 1; `locals.user` from Task 2
- Produces: `generateApiKey(): { key, prefix, keyHash }`; `parseApiKey(key): { prefix, secret } | null`; `hashSecret(secret): string`; `/keys` page with `create` and `revoke` actions; new keys shown ONCE via `form.generatedKey`

- [ ] **Step 1: Add the uuidv7 dependency**

```bash
cd /home/dwizzy/fudrouter/apps/web
NODE_ENV=development npm install -D uuidv7
```

- [ ] **Step 2: Write the failing tests**

`apps/web/src/lib/server/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashSecret, parseApiKey } from './keys';

describe('generateApiKey', () => {
	it('produces the sk-ar-<prefix>_<secret> format', () => {
		const { key } = generateApiKey();
		expect(key).toMatch(/^sk-ar-[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
	});

	it('hashes the secret, not the whole key', () => {
		const { key, prefix, keyHash } = generateApiKey();
		const parsed = parseApiKey(key)!;
		expect(parsed.prefix).toBe(prefix);
		expect(keyHash).toBe(hashSecret(parsed.secret));
		expect(keyHash).toHaveLength(64); // sha256 hex
		expect(key).not.toContain(keyHash);
	});

	it('generates unique keys', () => {
		const seen = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
		expect(seen.size).toBe(200);
	});
});

describe('parseApiKey', () => {
	it('parses a valid key', () => {
		const p = parseApiKey('sk-ar-abcdefgh_0123456789abcdef0123456789abcdef');
		expect(p).toEqual({
			prefix: 'abcdefgh',
			secret: '0123456789abcdef0123456789abcdef'
		});
	});

	it('rejects wrong prefix, missing secret, short parts', () => {
		expect(parseApiKey('sk-wrong-abcdefgh_0123456789abcdef0123456789abcdef')).toBeNull();
		expect(parseApiKey('sk-ar-abcdefgh')).toBeNull();
		expect(parseApiKey('sk-ar-ab_0123')).toBeNull();
		expect(parseApiKey('')).toBeNull();
	});
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run test -- --run src/lib/server/keys.test.ts
```
Expected: FAIL — cannot import `./keys`.

- [ ] **Step 4: Implement**

`apps/web/src/lib/server/keys.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randChars(n: number): string {
	const b = randomBytes(n);
	let s = '';
	for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
	return s;
}

/** Generate a new API key. The full key is shown to the user ONCE; only prefix + sha256(secret) are stored. */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
	const prefix = randChars(8);
	const secret = randChars(32);
	return {
		key: `sk-ar-${prefix}_${secret}`,
		prefix,
		keyHash: hashSecret(secret)
	};
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
	if (!key.startsWith('sk-ar-')) return null;
	const rest = key.slice('sk-ar-'.length);
	const i = rest.indexOf('_');
	if (i < 4) return null; // prefix must be >= 4 chars
	const prefix = rest.slice(0, i);
	const secret = rest.slice(i + 1);
	if (secret.length < 16) return null;
	return { prefix, secret };
}

export function hashSecret(secret: string): string {
	return createHash('sha256').update(secret, 'utf8').digest('hex');
}
```

- [ ] **Step 5: Run tests — PASS**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run test -- --run src/lib/server/keys.test.ts
```
Expected: 6 tests PASS.

- [ ] **Step 6: /keys page**

`apps/web/src/routes/keys/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiKey } from '$lib/server/db/schema';
import { generateApiKey } from '$lib/server/keys';
import { uuidv7 } from 'uuidv7';

export const load: PageServerLoad = async ({ locals }) => {
	const keys = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt,
			createdAt: apiKey.createdAt
		})
		.from(apiKey)
		.where(eq(apiKey.userId, locals.user!.id))
		.orderBy(desc(apiKey.createdAt));
	return { keys };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim() || 'default';

		const { key, prefix, keyHash } = generateApiKey();
		await db.insert(apiKey).values({
			id: uuidv7(),
			userId: locals.user!.id,
			name,
			prefix,
			keyHash,
			limits: {}
		});
		return { generatedKey: key, name };
	},
	revoke: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const rows = await db
			.update(apiKey)
			.set({ revokedAt: new Date() })
			.where(eq(apiKey.id, id))
			.returning({ id: apiKey.id, userId: apiKey.userId });
		if (rows.length === 0 || rows[0].userId !== locals.user!.id) {
			return fail(404, { error: 'Key not found' });
		}
		return { revoked: id };
	}
};
```

`apps/web/src/routes/keys/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<h1>API Keys</h1>

{#if form?.generatedKey}
	<div class="once">
		<p><strong>Copy your key now — it will never be shown again:</strong></p>
		<code>{form.generatedKey}</code>
	</div>
{/if}
{#if form?.error}<p class="error">{form.error}</p>{/if}

<form method="POST" action="?/create" use:enhance>
	<label>Name <input name="name" placeholder="my-key" /></label>
	<button type="submit">Create key</button>
</form>

<table>
	<thead>
		<tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>
	</thead>
	<tbody>
		{#each data.keys as k (k.id)}
			<tr>
				<td>{k.name}</td>
				<td><code>sk-ar-{k.prefix}_…</code></td>
				<td>{k.createdAt?.toISOString().slice(0, 10)}</td>
				<td>{k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
				<td>{k.revokedAt ? 'revoked' : 'active'}</td>
				<td>
					{#if !k.revokedAt}
						<form method="POST" action="?/revoke" use:enhance>
							<input type="hidden" name="id" value={k.id} />
							<button type="submit">Revoke</button>
						</form>
					{/if}
				</td>
			</tr>
		{/each}
	</tbody>
</table>

<style>
	.once {
		border: 1px solid #4a9;
		padding: 0.75rem 1rem;
		margin: 1rem 0;
	}
	.once code {
		display: block;
		margin-top: 0.5rem;
		word-break: break-all;
	}
	.error {
		color: #e66;
	}
</style>
```

- [ ] **Step 7: check + full test + commit**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run check && npm run test
cd /home/dwizzy/fudrouter
git add apps/web package-lock.json
git commit -m "feat(keys): hash-only API key generation and /keys management page"
```

---

## Task 4: Provider credentials (AES-256-GCM) + seed script

**Files:**
- Create: `apps/web/src/lib/server/credentials.ts`
- Create: `apps/web/src/lib/server/credentials.test.ts`
- Create: `apps/web/scripts/seed.mjs`
- Modify: `apps/web/.env.example`, `apps/web/.env`, `apps/web/package.json` (`seed` script)

**Interfaces:**
- Consumes: `provider`/`model` tables from Task 1
- Produces: `encryptCredentials(plain)/decryptCredentials(enc)` (TS, wire format `base64(iv[12]||ct||tag[16])`); `node scripts/seed.mjs` idempotent upsert of one provider + one model; env keys `CREDENTIALS_MASTER_KEY`, `SEED_*`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/server/credentials.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decryptCredentials, encryptCredentials } from './credentials';

describe('AES-256-GCM credentials', () => {
	it('round-trips', () => {
		const plain = { api_key: 'sk-live-abc123' };
		const enc = encryptCredentials(plain);
		expect(enc).not.toContain('sk-live-abc123');
		expect(decryptCredentials(enc)).toEqual(plain);
	});

	it('produces different ciphertexts per call (random IV)', () => {
		const a = encryptCredentials({ api_key: 'x' });
		const b = encryptCredentials({ api_key: 'x' });
		expect(a).not.toBe(b);
	});

	it('is 12-byte IV + ct + 16-byte tag, base64', () => {
		const enc = encryptCredentials({ api_key: 'x' });
		const buf = Buffer.from(enc, 'base64');
		// {"api_key":"x"} = 15 bytes plaintext; 12 + 15 + 16 = 43
		expect(buf.length).toBe(43);
	});

	it('rejects tampered ciphertext', () => {
		const enc = encryptCredentials({ api_key: 'x' });
		const buf = Buffer.from(enc, 'base64');
		buf[buf.length - 1] ^= 0xff;
		expect(() => decryptCredentials(buf.toString('base64'))).toThrow();
	});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run test -- --run src/lib/server/credentials.test.ts
```
Expected: FAIL — cannot import `./credentials`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/server/credentials.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function masterKey(): Buffer {
	const k = process.env.CREDENTIALS_MASTER_KEY;
	if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
	const buf = Buffer.from(k, 'base64');
	if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	return buf;
}

/** Wire format: base64(iv[12] || ciphertext || authTag[16]) — matches the Go data plane. */
export function encryptCredentials(plain: Record<string, string>): string {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

export function decryptCredentials(enc: string): Record<string, string> {
	const buf = Buffer.from(enc, 'base64');
	if (buf.length < 12 + 16) throw new Error('ciphertext too short');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(buf.length - 16);
	const ct = buf.subarray(12, buf.length - 16);
	const d = createDecipheriv('aes-256-gcm', masterKey(), iv);
	d.setAuthTag(tag);
	return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
```

- [ ] **Step 4: Run tests — PASS**

```bash
cd /home/dwizzy/fudrouter/apps/web
CREDENTIALS_MASTER_KEY=$(openssl rand -base64 32) npm run test -- --run src/lib/server/credentials.test.ts
```
Expected: 4 tests PASS. (Tests need the env var; it is NOT in .env yet.)

- [ ] **Step 5: Generate the real master key into .env, extend .env.example**

```bash
cd /home/dwizzy/fudrouter/apps/web
grep -q CREDENTIALS_MASTER_KEY .env || printf '\n# Provider credentials master key (openssl rand -base64 32)\nCREDENTIALS_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
```

Append to `apps/web/.env.example`:

```dotenv

# Provider credentials master key (openssl rand -base64 32)
CREDENTIALS_MASTER_KEY=replace-me-with-openssl-rand-base64-32

# Seed provider (any OpenAI-compatible endpoint). Prices = minor units per 1M tokens.
SEED_PROVIDER_NAME=dev-upstream
SEED_PROVIDER_BASE_URL=http://127.0.0.1:20128/v1
SEED_PROVIDER_API_KEY=replace-me
SEED_MODEL_SLUG=dev-model
SEED_MODEL_NAME=Dev Model
SEED_MODEL_INPUT_PRICE=150000.000000
SEED_MODEL_OUTPUT_PRICE=600000.000000
SEED_MODEL_CURRENCY=USD
```

- [ ] **Step 6: Seed script (idempotent upsert, raw SQL, no drizzle import needed)**

`apps/web/scripts/seed.mjs`:

```js
// Usage: node --env-file=.env scripts/seed.mjs
// Idempotently upserts one provider + one model from SEED_* env vars.
import postgres from 'postgres';
import { createCipheriv, randomBytes } from 'node:crypto';

const required = [
	'DATABASE_URL',
	'CREDENTIALS_MASTER_KEY',
	'SEED_PROVIDER_NAME',
	'SEED_PROVIDER_BASE_URL',
	'SEED_PROVIDER_API_KEY',
	'SEED_MODEL_SLUG',
	'SEED_MODEL_NAME',
	'SEED_MODEL_INPUT_PRICE',
	'SEED_MODEL_OUTPUT_PRICE',
	'SEED_MODEL_CURRENCY'
];
for (const k of required) {
	if (!process.env[k]) {
		console.error(`missing env: ${k}`);
		process.exit(1);
	}
}

function encrypt(plain) {
	const key = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'base64');
	if (key.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

const sql = postgres(process.env.DATABASE_URL);
const providerId = crypto.randomUUID();
const modelId = crypto.randomUUID();

const provider = await sql`
	insert into provider (id, name, base_url, credentials_enc, status, priority)
	values (${providerId}, ${process.env.SEED_PROVIDER_NAME}, ${process.env.SEED_PROVIDER_BASE_URL},
	        ${encrypt({ api_key: process.env.SEED_PROVIDER_API_KEY })}, 'active', 100)
	on conflict (name) do update
	  set base_url = excluded.base_url,
	      credentials_enc = excluded.credentials_enc,
	      status = 'active'
	returning id`;
const pid = provider[0].id;

const model = await sql`
	insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status)
	values (${modelId}, ${pid}, ${process.env.SEED_MODEL_NAME}, ${process.env.SEED_MODEL_SLUG},
	        128000, ${process.env.SEED_MODEL_INPUT_PRICE}, ${process.env.SEED_MODEL_OUTPUT_PRICE},
	        ${process.env.SEED_MODEL_CURRENCY}, 'active')
	on conflict (slug) do update
	  set provider_id = excluded.provider_id,
	      name = excluded.name,
	      input_price = excluded.input_price,
	      output_price = excluded.output_price,
	      currency = excluded.currency,
	      status = 'active'
	returning id, slug`;

console.log(`seeded: provider ${process.env.SEED_PROVIDER_NAME} (${pid}), model ${model[0].slug} (${model[0].id})`);
await sql.end();
```

Note: `provider.name` needs a unique constraint for `on conflict (name)` — add to Task 1's schema? **No** — modify here: this task adds `uniqueIndex('provider_name_idx').on(t.name)` to `schema.ts`, regenerates + applies the migration (Step 6a below).

- [ ] **Step 6a: unique name on provider**

In `apps/web/src/lib/server/db/schema.ts`, change the `provider` table definition's trailing `(t) => []` — the table currently has no index block; add one:

```ts
export const provider = pgTable(
	'provider',
	{
		/* …existing columns unchanged… */
	},
	(t) => [uniqueIndex('provider_name_idx').on(t.name)]
);
```

Then:
```bash
cd /home/dwizzy/fudrouter/apps/web
NODE_ENV=development npx drizzle-kit generate && NODE_ENV=development npm run db:migrate
```

- [ ] **Step 7: Add the npm script and run the seed with real values**

Add to `apps/web/package.json` scripts: `"seed": "node --env-file=.env scripts/seed.mjs"`.

Fill `SEED_*` in `apps/web/.env` with a **live OpenAI-compatible upstream** (discover at execution — candidates: local OmniRoute on `127.0.0.1:20128`, or any provider key available in the environment; the URL must serve `POST {base}/chat/completions`). Then:

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run seed
```
Expected: `seeded: provider … , model dev-model (…)`.

- [ ] **Step 8: Verify the row is encrypted + check + commit**

```bash
docker exec fudrouter-db psql -U fudrouter -d fudrouter -tAc "select credentials_enc from provider;" | head -1
```
Expected: a base64 blob ≥ 60 chars — NOT the plaintext API key.

```bash
cd /home/dwizzy/fudrouter/apps/web
npm run check && npm run test
cd /home/dwizzy/fudrouter
git add apps/web infra/migrations package-lock.json
git commit -m "feat(provider): AES-256-GCM credentials + idempotent seed script"
```
(`.env` is gitignored — never committed.)

---

## Task 5: Go data plane — key validation, proxy, request_log

**Files:**
- Modify: `services/router/go.mod` (deps: `github.com/jackc/pgx/v5`, `github.com/gofrs/uuid`)
- Create: `services/router/internal/keys/keys.go` + `keys_test.go`
- Create: `services/router/internal/cost/cost.go` + `cost_test.go`
- Create: `services/router/internal/crypt/crypt.go` + `crypt_test.go`
- Create: `services/router/internal/store/store.go`
- Create: `services/router/internal/proxy/proxy.go` + `proxy_test.go`
- Modify: `services/router/main.go`
- Modify: `.github/workflows/ci.yml` (go.sum now exists — no change needed; keep as-is)

**Interfaces:**
- Consumes: `api_key`, `model`, `provider`, `request_log` tables (Task 1); seed rows (Task 4); env `DATABASE_URL`, `CREDENTIALS_MASTER_KEY`, `ROUTER_ADDR`
- Produces: `POST /v1/chat/completions` (OpenAI-compatible, SSE streaming, writes `request_log`), `GET /v1/models` (OpenAI list format), `GET /health` (existing). Package APIs: `keys.Parse/Hash/Equal`, `cost.Compute(tokensIn, tokensOut, priceIn, priceOut)`, `crypt.Decrypt`, `store.New(pool)`, `store.LookupAPIKey`, `store.ModelWithProvider`, `store.InsertRequestLog`, `store.TouchAPIKey`, `proxy.New(store, httpClient)`.

- [ ] **Step 1: Dependencies**

```bash
cd /home/dwizzy/fudrouter/services/router
go get github.com/jackc/pgx/v5@latest github.com/gofrs/uuid@latest
go mod tidy
```

- [ ] **Step 2: Failing tests — keys**

`services/router/internal/keys/keys_test.go`:

```go
package keys

import "testing"

func TestParse(t *testing.T) {
	p, ok := Parse("sk-ar-abcdefgh_0123456789abcdef0123456789abcdef")
	if !ok || p.Prefix != "abcdefgh" || p.Secret != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("got %+v ok=%v", p, ok)
	}
	for _, bad := range []string{"", "sk-wrong-x_y", "sk-ar-abcdefgh", "sk-ar-ab_0123", "sk-ar-abcdefgh_"} {
		if _, ok := Parse(bad); ok {
			t.Errorf("accepted bad key %q", bad)
		}
	}
}

func TestHashAndEqualConstantTime(t *testing.T) {
	h := Hash("0123456789abcdef0123456789abcdef")
	if len(h) != 64 {
		t.Fatalf("hash length %d", len(h))
	}
	if !Equal(h, Hash("0123456789abcdef0123456789abcdef")) {
		t.Error("same secret should match")
	}
	if Equal(h, Hash("different-secret-0123456789abcdef")) {
		t.Error("different secret should not match")
	}
}
```

Run: `go test ./internal/keys/` → expect FAIL (no package).

- [ ] **Step 3: Implement keys**

`services/router/internal/keys/keys.go`:

```go
// Package keys parses and validates sk-ar- API keys.
// Wire format: sk-ar-<prefix>_<secret>. Only sha256(secret) is stored.
package keys

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strings"
)

type Key struct {
	Prefix string
	Secret string
}

func Parse(k string) (Key, bool) {
	const marker = "sk-ar-"
	if !strings.HasPrefix(k, marker) {
		return Key{}, false
	}
	rest := k[len(marker):]
	i := strings.IndexByte(rest, '_')
	if i < 4 {
		return Key{}, false
	}
	prefix, secret := rest[:i], rest[i+1:]
	if len(secret) < 16 {
		return Key{}, false
	}
	return Key{Prefix: prefix, Secret: secret}, true
}

func Hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Equal compares two hex hashes in constant time.
func Equal(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
```

Run: `go test ./internal/keys/` → PASS.

- [ ] **Step 4: Failing tests — cost (Review Focus 2: exact int math)**

`services/router/internal/cost/cost_test.go`:

```go
package cost

import "testing"

func TestComputeExact(t *testing.T) {
	// price 150000.000000 micro-USD per 1M input tokens, 600000.000000 output.
	in, out := Price("150000.000000"), Price("600000.000000")
	// 1000 in, 500 out: 1000*150000/1e6 + 500*600000/1e6 = 150 + 300 = 450 micro
	got := Compute(1000, 500, in, out)
	if got != 450 {
		t.Fatalf("cost = %d, want 450", got)
	}
}

func TestComputeZeroTokens(t *testing.T) {
	if Compute(0, 0, Price("150000.000000"), Price("600000.000000")) != 0 {
		t.Fatal("zero tokens must cost zero")
	}
}

func TestComputeRounding(t *testing.T) {
	// 1 token at 150000/1e6 = 0.15 micro -> rounds to 0
	if Compute(1, 0, Price("150000.000000"), Price("0")) != 0 {
		t.Fatal("1 token should round to 0")
	}
	// 3 tokens at 500000/1e6 = 1.5 micro -> rounds to 2 (half up)
	if Compute(3, 0, Price("500000.000000"), Price("0")) != 2 {
		t.Fatal("3 tokens at 500000 should round to 2")
	}
}

func TestPriceParse(t *testing.T) {
	if Price("150000.000000") != 150000_000000 {
		t.Fatalf("Price parse wrong: %d", Price("150000.000000"))
	}
	if Price("0") != 0 {
		t.Fatal("zero price")
	}
}
```

Run: `go test ./internal/cost/` → FAIL.

- [ ] **Step 5: Implement cost**

`services/router/internal/cost/cost.go`:

```go
// Package cost computes request cost in integer micro-units of the model's currency.
//
// Prices are numeric(12,6): MINOR currency units per 1M tokens.
// Price("150000.000000") == 150000 micro-USD per 1M input tokens ($0.15/1M).
// Internally scaled by 1e6 (pico-scale) so all math stays in int64.
//
// Safe bounds: tokens < 1e7 and scaled price < 9e11 keep the product < 9.2e18 (int64 max).
// A price above 900000.000000 minor/1M or a request above 10M tokens is out of contract.
package cost

import (
	"strconv"
	"strings"
)

// Price parses a numeric(12,6) string into int64 scaled by 1e6.
func Price(s string) int64 {
	s = strings.TrimSpace(s)
	i := strings.IndexByte(s, '.')
	if i < 0 {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v * 1_000_000
	}
	intPart := s[:i]
	frac := s[i+1:]
	for len(frac) < 6 {
		frac += "0"
	}
	if len(frac) > 6 {
		frac = frac[:6]
	}
	v, _ := strconv.ParseInt(intPart, 10, 64)
	f, _ := strconv.ParseInt(frac, 10, 64)
	return v*1_000_000 + f
}

// Compute returns total cost in micro-units: tokens × price / 1e6, half-up rounding.
func Compute(tokensIn, tokensOut int64, priceIn, priceOut int64) int64 {
	return divRound(tokensIn*priceIn, 1_000_000) + divRound(tokensOut*priceOut, 1_000_000)
}

func divRound(a, b int64) int64 {
	if a >= 0 {
		return (a + b/2) / b
	}
	return -((-a + b/2) / b)
}
```

Run: `go test ./internal/cost/` → PASS.

- [ ] **Step 6: Failing tests — crypt (must match TS wire format)**

`services/router/internal/crypt/crypt_test.go`:

```go
package crypt

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	c, err := New(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	enc, err := c.Encrypt(`{"api_key":"sk-test"}`)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains([]byte(enc), []byte("sk-test")) {
		t.Fatal("plaintext leaked")
	}
	dec, err := c.Decrypt(enc)
	if err != nil || dec != `{"api_key":"sk-test"}` {
		t.Fatalf("dec=%q err=%v", dec, err)
	}
}

func TestTamperFails(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	c, _ := New(base64.StdEncoding.EncodeToString(key))
	enc, _ := c.Encrypt("hello")
	raw, _ := base64.StdEncoding.DecodeString(enc)
	raw[len(raw)-1] ^= 0xff
	if _, err := c.Decrypt(base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("tampered ciphertext must fail")
	}
}

// TestWireFormatMatchesTS pins the exact layout the TypeScript side produces:
// base64(iv[12] || ciphertext || tag[16]).
func TestWireFormatMatchesTS(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	iv := make([]byte, 12)
	rand.Read(iv)
	ct := gcm.Seal(nil, iv, []byte(`{"api_key":"x"}`), nil)
	wire := base64.StdEncoding.EncodeToString(append(append(iv, ct...)))
	// gcm.Seal appends the 16-byte tag to ct, so wire == iv||ct||tag already.

	c, _ := New(base64.StdEncoding.EncodeToString(key))
	dec, err := c.Decrypt(wire)
	if err != nil || dec != `{"api_key":"x"}` {
		t.Fatalf("TS-format decrypt failed: %q %v", dec, err)
	}
}
```

Run: `go test ./internal/crypt/` → FAIL.

- [ ] **Step 7: Implement crypt**

`services/router/internal/crypt/crypt.go`:

```go
// Package crypt decrypts provider credentials: AES-256-GCM,
// wire format base64(iv[12] || ciphertext || tag[16]) — identical to the TS control plane.
package crypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
)

type Crypt struct{ aead cipher.AEAD }

// New reads CREDENTIALS_MASTER_KEY (base64 of 32 bytes) from the environment.
func New(envValue string) (*Crypt, error) {
	if envValue == "" {
		return nil, errors.New("CREDENTIALS_MASTER_KEY is not set")
	}
	key, err := base64.StdEncoding.DecodeString(envValue)
	if err != nil {
		return nil, fmt.Errorf("CREDENTIALS_MASTER_KEY not valid base64: %w", err)
	}
	if len(key) != 32 {
		return nil, errors.New("CREDENTIALS_MASTER_KEY must be base64 of 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Crypt{aead: aead}, nil
}

func FromEnv() (*Crypt, error) { return New(os.Getenv("CREDENTIALS_MASTER_KEY")) }

func (c *Crypt) Encrypt(plaintext string) (string, error) {
	iv := make([]byte, 12)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nil, iv, []byte(plaintext), nil) // ct||tag
	return base64.StdEncoding.EncodeToString(append(iv, sealed...)), nil
}

func (c *Crypt) Decrypt(wire string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(wire)
	if err != nil {
		return "", err
	}
	if len(raw) < 12+16 {
		return "", errors.New("ciphertext too short")
	}
	iv, sealed := raw[:12], raw[12:]
	pt, err := c.aead.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt failed (wrong master key or tampered): %w", err)
	}
	return string(pt), nil
}
```

Run: `go test ./internal/crypt/` → PASS.

- [ ] **Step 8: Store (pgx)**

`services/router/internal/store/store.go`:

```go
// Package store is the data plane's only database access.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/gofrs/uuid/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Store struct{ pool *pgxpool.Pool }

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

type APIKeyRow struct {
	ID        string
	UserID    string
	KeyHash   string
	RevokedAt *time.Time
}

func (s *Store) LookupAPIKey(ctx context.Context, prefix string) (*APIKeyRow, error) {
	row := &APIKeyRow{}
	err := s.pool.QueryRow(ctx,
		`select id, user_id, key_hash, revoked_at from api_key where prefix = $1`, prefix,
	).Scan(&row.ID, &row.UserID, &row.KeyHash, &row.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return row, err
}

type ModelRow struct {
	ModelID     string
	ProviderID  string
	Slug        string
	InputPrice  string
	OutputPrice string
	Currency    string
	BaseURL     string
	CredEnc     string
}

func (s *Store) ModelWithProvider(ctx context.Context, slug string) (*ModelRow, error) {
	row := &ModelRow{}
	err := s.pool.QueryRow(ctx, `
		select m.id, m.provider_id, m.slug, m.input_price, m.output_price, m.currency,
		       p.base_url, p.credentials_enc
		from model m join provider p on p.id = m.provider_id
		where m.slug = $1 and m.status = 'active' and p.status = 'active'`, slug,
	).Scan(&row.ModelID, &row.ProviderID, &row.Slug, &row.InputPrice, &row.OutputPrice,
		&row.Currency, &row.BaseURL, &row.CredEnc)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return row, err
}

func (s *Store) TouchAPIKey(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `update api_key set last_used_at = now() where id = $1`, id)
	return err
}

func (s *Store) InsertRequestLog(ctx context.Context, r *RequestLog) error {
	if r.ID == "" {
		r.ID = uuid.Must(uuid.NewV7()).String()
	}
	_, err := s.pool.Exec(ctx, `
		insert into request_log
		  (id, user_id, api_key_id, model_id, provider_id, tokens_in, tokens_out,
		   cost, currency, latency_ms, status, error)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		r.ID, r.UserID, r.APIKeyID, r.ModelID, r.ProviderID, r.TokensIn, r.TokensOut,
		r.Cost, r.Currency, r.LatencyMs, r.Status, r.Error)
	return err
}

type RequestLog struct {
	ID         string
	UserID     string
	APIKeyID   string
	ModelID    string
	ProviderID string
	TokensIn   int64
	TokensOut  int64
	Cost       int64
	Currency   string
	LatencyMs  int64
	Status     string
	Error      string
}

type ModelInfo struct{ Slug, Name string }

func (s *Store) ActiveModels(ctx context.Context) ([]ModelInfo, error) {
	rows, err := s.pool.Query(ctx, `select slug, name from model where status = 'active' order by slug`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ModelInfo
	for rows.Next() {
		var m ModelInfo
		if err := rows.Scan(&m.Slug, &m.Name); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
```

- [ ] **Step 9: Proxy — failing test with httptest upstream (Review Focus 1 & 3)**

`services/router/internal/proxy/proxy_test.go`:

```go
package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/tests"
)

// The test seeds a real api_key + provider + model row in the dev database when
// DATABASE_URL is set (on-box); in CI (no env) the DB-backed cases skip.
func dbURL() string { return os.Getenv("DATABASE_URL") }

func newUpstream(t *testing.T, chunks []string, gotAuth *string, gotBody *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*gotAuth = r.Header.Get("Authorization")
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		*gotBody = string(buf[:n])
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		for _, c := range chunks {
			fmt.Fprintf(w, "data: %s\n\n", c)
			fl.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
}

func TestCompletionsStreamsAndLogs(t *testing.T) {
	dsn := dbURL()
	if dsn == "" {
		t.Skip("DATABASE_URL not set — DB-backed proxy test skipped (CI)")
	}
	var gotAuth, gotBody string
	up := newUpstream(t, []string{
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hel"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"lo"}}]}`,
		`{"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
	}, &gotAuth, &gotBody)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL) // helper: creates key/provider/model rows, returns IDs
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	body := `{"model":"` + env.Slug + `","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, `"Hel"`) || !strings.Contains(out, `"lo"`) {
		t.Error("SSE chunks missing/corrupted")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "data: [DONE]") {
		t.Error("D terminator not forwarded")
	}
	if gotAuth != "Bearer "+env.UpstreamKey {
		t.Errorf("upstream auth = %q", gotAuth)
	}
	if !strings.Contains(gotBody, `"stream_options":{"include_usage":true}`) {
		t.Error("stream_options not injected")
	}

	// request_log row must exist with exact tokens and cost
	log := tests.LastRequestLog(t, dsn, env.APIKeyID)
	if log.TokensIn != 11 || log.TokensOut != 7 {
		t.Errorf("tokens %d/%d", log.TokensIn, log.TokensOut)
	}
	// 11*150000/1e6 + 7*600000/1e6 = 1.65 + 4.2 = 5.85 -> 6 micro (half-up)
	if log.Cost != 6 {
		t.Errorf("cost %d, want 6", log.Cost)
	}
	if log.Status != "success" {
		t.Errorf("status %q", log.Status)
	}
}

func TestRevokedKeyRejected(t *testing.T) {
	dsn := dbURL()
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	var a, b string
	up := newUpstream(t, []string{`{}`}, &a, &b)
	defer up.Close()

	env := tests.SeedEnv(t, dsn, up.URL)
	tests.RevokeKey(t, dsn, env.APIKeyID)
	p := tests.NewProxy(t, dsn, up.URL)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"`+env.Slug+`","messages":[]}`))
	req.Header.Set("Authorization", "Bearer "+env.Key)
	p.ServeCompletions(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked key: status %d, want 401", rec.Code)
	}
}

func TestBadKeyRejectedWithoutDBHit(t *testing.T) {
	dsn := dbURL()
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	var a, b string
	up := newUpstream(t, []string{`{}`}, &a, &b)
	defer up.Close()
	p := tests.NewProxy(t, dsn, up.URL)

	for _, hdr := range []string{"", "Bearer wrong", "Bearer sk-ar-nope_short"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
			strings.NewReader(`{"model":"x","messages":[]}`))
		if hdr != "" {
			req.Header.Set("Authorization", hdr)
		}
		p.ServeCompletions(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("hdr %q: status %d, want 401", hdr, rec.Code)
		}
	}
}
```

This test needs a `tests` helper package. Create `services/router/tests/helpers_test.go` (package `tests`, exported helpers used by proxy_test — note: helper lives in a normal package so both current and future tests can use it):

`services/router/tests/helpers.go`:

```go
// Package tests provides DB-backed test helpers for the data plane.
// Requires DATABASE_URL pointing at the dev Postgres; tests that use it skip in CI.
package tests

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"

	"github.com/gofrs/uuid/v5"
	"github.com/jackc/pgx/v5"
)

type Env struct {
	Key        string // full sk-ar-... key
	Prefix     string
	APIKeyID   string
	UserID     string
	Slug       string
	ModelID    string
	ProviderID string
	UpstreamKey string
}

const UpstreamKeyPlain = "sk-upstream-test-key"

func randChars(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	rand.Read(b)
	out := make([]byte, n)
	for i := range out {
		out[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(out)
}

func secretHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// SeedEnv inserts a throwaway user + key + provider + model pointing at upstreamBaseURL.
func SeedEnv(t *testing.T, dsn, upstreamBaseURL string) *Env {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close(ctx) })

	uid := "u_" + randChars(8)
	_, err = conn.Exec(ctx,
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ($1,'T','t_`+uid+`@example.com', true, now(), now())`, uid)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { conn.Exec(ctx, `delete from "user" where id=$1`, uid) })

	prefix := randChars(8)
	secret := randChars(32)
	kid := uuid.Must(uuid.NewV7()).String()
	_, err = conn.Exec(ctx,
		`insert into api_key (id, user_id, name, prefix, key_hash, limits, created_at)
		 values ($1,$2,'test',$3,$4,'{}'::jsonb, now())`, kid, uid, prefix, secretHash(secret))
	if err != nil {
		t.Fatalf("seed key: %v", err)
	}

	cr, err := crypt.New(testMasterKey(t))
	if err != nil {
		t.Fatal(err)
	}
	credJSON, _ := json.Marshal(map[string]string{"api_key": UpstreamKeyPlain})
	enc, err := cr.Encrypt(string(credJSON))
	if err != nil {
		t.Fatal(err)
	}

	pid := uuid.Must(uuid.NewV7()).String()
	slug := "t_" + randChars(6)
	mid := uuid.Must(uuid.NewV7()).String()
	_, err = conn.Exec(ctx, `
		insert into provider (id, name, base_url, credentials_enc, status, priority, created_at)
		values ($1, $2, $3, $4, 'active', 100, now())`,
		pid, "test-provider-"+slug, upstreamBaseURL, enc)
	if err != nil {
		t.Fatalf("seed provider: %v", err)
	}
	t.Cleanup(func() { conn.Exec(ctx, `delete from provider where id=$1`, pid) })

	_, err = conn.Exec(ctx, `
		insert into model (id, provider_id, name, slug, context, input_price, output_price, currency, status, created_at)
		values ($1,$2,'Test',$3,128000,'150000.000000','600000.000000','USD','active', now())`,
		mid, pid, slug)
	if err != nil {
		t.Fatalf("seed model: %v", err)
	}
	t.Cleanup(func() { conn.Exec(ctx, `delete from model where id=$1`, mid) })

	return &Env{
		Key: "sk-ar-" + prefix + "_" + secret,
		Prefix: prefix, APIKeyID: kid, UserID: uid,
		Slug: slug, ModelID: mid, ProviderID: pid,
		UpstreamKey: UpstreamKeyPlain,
	}
}

func testMasterKey(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("CREDENTIALS_MASTER_KEY"); v != "" {
		return v
	}
	// deterministic 32-byte key for tests
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func NewProxy(t *testing.T, dsn, _ string) *proxy.Handler {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	cr, err := crypt.New(testMasterKey(t))
	if err != nil {
		t.Fatal(err)
	}
	return proxy.New(st, cr, &http.Client{Timeout: 30 * time.Second})
}

func RevokeKey(t *testing.T, dsn, keyID string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `update api_key set revoked_at = now() where id = $1`, keyID); err != nil {
		t.Fatal(err)
	}
}

type LastLog struct{ TokensIn, TokensOut, Cost int64; Status string }

func LastRequestLog(t *testing.T, dsn, apiKeyID string) LastLog {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var l LastLog
	err = conn.QueryRow(ctx, `
		select tokens_in, tokens_out, cost, status from request_log
		where api_key_id = $1 order by created_at desc limit 1`, apiKeyID,
	).Scan(&l.TokensIn, &l.TokensOut, &l.Cost, &l.Status)
	if err != nil {
		t.Fatalf("request_log lookup: %v", err)
	}
	return l
}
```

- [ ] **Step 10: Implement the proxy**

`services/router/internal/proxy/proxy.go`:

```go
// Package proxy serves the OpenAI-compatible hot path.
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/cost"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/keys"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

type Handler struct {
	store  *store.Store
	crypt  *crypt.Crypt
	client *http.Client
}

func New(st *store.Store, cr *crypt.Crypt, client *http.Client) *Handler {
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	return &Handler{store: st, crypt: cr, client: client}
}

func (h *Handler) writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": msg}})
}

// authenticate parses + validates the Bearer key against the api_key table.
func (h *Handler) authenticate(r *http.Request) (*store.APIKeyRow, error) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	k, ok := keys.Parse(strings.TrimPrefix(auth, "Bearer "))
	if !ok {
		return nil, errors.New("malformed api key")
	}
	row, err := h.store.LookupAPIKey(r.Context(), k.Prefix)
	if err != nil {
		return nil, errors.New("invalid api key")
	}
	if !keys.Equal(row.KeyHash, keys.Hash(k.Secret)) {
		return nil, errors.New("invalid api key")
	}
	if row.RevokedAt != nil {
		return nil, errors.New("api key revoked")
	}
	return row, nil
}

func (h *Handler) ServeCompletions(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	keyRow, err := h.authenticate(r)
	if err != nil {
		h.writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		h.writeErr(w, http.StatusBadRequest, "cannot read body")
		return
	}
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	slug, _ := req["model"].(string)
	if slug == "" {
		h.writeErr(w, http.StatusBadRequest, "missing model")
		return
	}
	stream, _ := req["stream"].(bool)

	m, err := h.store.ModelWithProvider(r.Context(), slug)
	if err != nil {
		h.writeErr(w, http.StatusNotFound, "unknown model: "+slug)
		return
	}

	credJSON, err := h.crypt.Decrypt(m.CredEnc)
	if err != nil {
		// Never include the ciphertext or plaintext in errors (Review Focus 4).
		log.Printf("[proxy] credential decrypt failed for provider %s", m.ProviderID)
		h.writeErr(w, http.StatusInternalServerError, "provider credentials unavailable")
		return
	}
	var cred struct {
		APIKey string `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(credJSON), &cred); err != nil || cred.APIKey == "" {
		h.writeErr(w, http.StatusInternalServerError, "provider credentials malformed")
		return
	}

	if stream {
		req["stream_options"] = map[string]any{"include_usage": true}
	}
	upBody, _ := json.Marshal(req)

	upReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost,
		strings.TrimRight(m.BaseURL, "/")+"/chat/completions", bytes.NewReader(upBody))
	if err != nil {
		h.writeErr(w, http.StatusInternalServerError, "upstream request build failed")
		return
	}
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Authorization", "Bearer "+cred.APIKey)

	resp, err := h.client.Do(upReq)
	if err != nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", err.Error())
		h.writeErr(w, http.StatusBadGateway, "upstream request failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "upstream_error",
			fmt.Sprintf("upstream %d", resp.StatusCode))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(errBody)
		return
	}

	_ = h.store.TouchAPIKey(r.Context(), keyRow.ID)

	if stream {
		h.streamSSE(w, r, resp.Body, keyRow, m, start)
		return
	}

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		h.logRequest(r.Context(), keyRow, m, 0, 0, start, "error", "read upstream: "+err.Error())
		h.writeErr(w, http.StatusBadGateway, "upstream read failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(respBody)

	var parsed struct {
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	_ = json.Unmarshal(respBody, &parsed)
	tin, tout := int64(0), int64(0)
	if parsed.Usage != nil {
		tin, tout = parsed.Usage.PromptTokens, parsed.Usage.CompletionTokens
	}
	h.logRequest(r.Context(), keyRow, m, tin, tout, start, "success", "")
}

// streamSSE copies the upstream SSE to the client line-group by line-group,
// capturing the usage object from the final data chunk.
func (h *Handler) streamSSE(w http.ResponseWriter, body io.Reader, keyRow *store.APIKeyRow, m *store.ModelRow, start time.Time) {
	fl, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	var tokensIn, tokensOut int64
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		_, _ = fmt.Fprintln(w, line)
		if fl != nil {
			fl.Flush()
		}
		if strings.HasPrefix(line, "data: ") {
			payload := strings.TrimPrefix(line, "data: ")
			if payload != "[DONE]" {
				var chunk struct {
					Usage *struct {
						PromptTokens     int64 `json:"prompt_tokens"`
						CompletionTokens int64 `json:"completion_tokens"`
					} `json:"usage"`
				}
				if err := json.Unmarshal([]byte(payload), &chunk); err == nil && chunk.Usage != nil {
					tokensIn = chunk.Usage.PromptTokens
					tokensOut = chunk.Usage.CompletionTokens
				}
			}
		}
	}
	if err := sc.Err(); err != nil {
		h.logRequest(context.Background(), keyRow, m, tokensIn, tokensOut, start, "error", "stream: "+err.Error())
		return
	}
	h.logRequest(context.Background(), keyRow, m, tokensIn, tokensOut, start, "success", "")
}

func (h *Handler) logRequest(ctx context.Context, keyRow *store.APIKeyRow, m *store.ModelRow, tin, tout int64, start time.Time, status, errText string) {
	c := cost.Compute(tin, tout, cost.Price(m.InputPrice), cost.Price(m.OutputPrice))
	if err := h.store.InsertRequestLog(ctx, &store.RequestLog{
		UserID:     keyRow.UserID,
		APIKeyID:   keyRow.ID,
		ModelID:    m.ModelID,
		ProviderID: m.ProviderID,
		TokensIn:   tin,
		TokensOut:  tout,
		Cost:       c,
		Currency:   m.Currency,
		LatencyMs:  time.Since(start).Milliseconds(),
		Status:     status,
		Error:      errText,
	}); err != nil {
		log.Printf("[proxy] request_log insert failed: %v", err)
	}
}

func (h *Handler) ServeModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.store.ActiveModels(r.Context())
	if err != nil {
		h.writeErr(w, http.StatusInternalServerError, "database error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"object": "list",
		"data": models,
	})
}
```

Note: `ServeModels` must emit OpenAI shape — build the data array explicitly:

```go
	data := make([]map[string]any, 0, len(models))
	for _, m := range models {
		data = append(data, map[string]any{"id": m.Slug, "object": "model", "owned_by": "fudrouter"})
	}
```
and encode `data` (drop the placeholder above — final code uses this `data` slice).

- [ ] **Step 11: Wire main.go**

`services/router/main.go` — full replacement:

```go
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/anvxxr-arch/fudrouter/services/router/internal/crypt"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/proxy"
	"github.com/anvxxr-arch/fudrouter/services/router/internal/store"
)

const serviceName = "fudrouter-router"

// newHealthHandler reports service identity. The data plane must be
// independently identifiable so the control plane can tell it apart from
// the web app in health checks and logs.
func newHealthHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"service": serviceName,
		})
	})
}

func main() {
	addr := os.Getenv("ROUTER_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8100"
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatalf("[%s] DATABASE_URL is not set", serviceName)
	}

	ctx := context.Background()
	st, err := store.New(ctx, dsn)
	if err != nil {
		log.Fatalf("[%s] store init: %v", serviceName, err)
	}
	defer st.Close()

	cr, err := crypt.FromEnv()
	if err != nil {
		log.Fatalf("[%s] crypt init: %v", serviceName, err)
	}

	p := proxy.New(st, cr, nil)

	mux := http.NewServeMux()
	mux.Handle("GET /health", newHealthHandler())
	mux.Handle("GET /v1/models", http.HandlerFunc(p.ServeModels))
	mux.Handle("POST /v1/chat/completions", http.HandlerFunc(p.ServeCompletions))

	log.Printf("[%s] listening on %s", serviceName, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("[%s] server failed: %v", serviceName, err)
	}
}
```

- [ ] **Step 12: Run everything**

```bash
cd /home/dwizzy/fudrouter/services/router
go vet ./... && go test ./...
```
Expected: vet silent; keys/cost/crypt PASS unconditionally; proxy tests PASS when `DATABASE_URL` is set:
```bash
set -a; source ../apps/web/.env; set +a
DATABASE_URL=$DATABASE_URL CREDENTIALS_MASTER_KEY=$CREDENTIALS_MASTER_KEY go test ./internal/proxy/ ./tests/ -v
```
Expected: 3 proxy tests PASS (no skips).

- [ ] **Step 13: Commit**

```bash
cd /home/dwizzy/fudrouter
git add services/router
git commit -m "feat(router): /v1/chat/completions with key validation, SSE proxy, request logging"
```

---

## Task 6: /usage page, PM2 deploy, E2E smoke, acceptance

**Files:**
- Create: `apps/web/src/routes/usage/+page.server.ts`, `apps/web/src/routes/usage/+page.svelte`
- Create: `apps/web/src/lib/server/format.ts` (+ test)
- Create: `infra/ecosystem.config.cjs`
- Create: `apps/web/src/e2e/smoke.spec.ts`
- Modify: `apps/web/package.json` (`test:e2e` script), `apps/web/vite.config.ts` (exclude `src/e2e` from unit test projects if they pick it up)
- Modify: `.github/workflows/ci.yml` (add `db:check` step)

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: `/usage` SSR page; PM2 processes `fudrouter-web` (:3000) + `fudrouter-router` (:8100); `npm run test:e2e` = the S0 acceptance gate

- [ ] **Step 1: Money formatting helper (display-only float boundary)**

`apps/web/src/lib/server/format.ts`:

```ts
/** cost is micro-units (int64). Render major units for display only — never compute with the result. */
export function formatCost(micro: bigint, currency: string): string {
	const major = Number(micro / 1_000_000n);
	const frac = Number(micro % 1_000_000n) / 1_000_000;
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major + frac);
}
```

`apps/web/src/lib/server/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatCost } from './format';

describe('formatCost', () => {
	it('renders micro-units as currency', () => {
		expect(formatCost(150n, 'USD')).toBe('$0.00');
		expect(formatCost(1_500_000n, 'USD')).toBe('$1.50');
		expect(formatCost(456n, 'USD')).toMatch(/\$0\.00/);
	});
});
```

- [ ] **Step 2: /usage page**

`apps/web/src/routes/usage/+page.server.ts`:

```ts
import type { PageServerLoad } from './$types';
import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requestLog, model } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	const rows = await db
		.select({
			id: requestLog.id,
			modelSlug: model.slug,
			tokensIn: requestLog.tokensIn,
			tokensOut: requestLog.tokensOut,
			cost: requestLog.cost,
			currency: requestLog.currency,
			latencyMs: requestLog.latencyMs,
			status: requestLog.status,
			createdAt: requestLog.createdAt
		})
		.from(requestLog)
		.innerJoin(model, eq(model.id, requestLog.modelId))
		.where(eq(requestLog.userId, locals.user!.id))
		.orderBy(desc(requestLog.createdAt))
		.limit(50);
	return { rows };
};
```

`apps/web/src/routes/usage/+page.svelte`:

```svelte
<script lang="ts">
	import { formatCost } from '$lib/server/format';
	let { data } = $props();
</script>

<h1>Usage</h1>

<table>
	<thead>
		<tr><th>When</th><th>Model</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th><th>Latency</th><th>Status</th></tr>
	</thead>
	<tbody>
		{#each data.rows as r (r.id)}
			<tr>
				<td>{r.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
				<td>{r.modelSlug}</td>
				<td>{r.tokensIn}</td>
				<td>{r.tokensOut}</td>
				<td>{formatCost(r.cost, r.currency)}</td>
				<td>{r.latencyMs} ms</td>
				<td>{r.status}</td>
			</tr>
		{:else}
			<tr><td colspan="7">No requests yet.</td></tr>
		{/each}
	</tbody>
</table>
```

- [ ] **Step 3: PM2 ecosystem**

`infra/ecosystem.config.cjs`:

```js
// Start with the app env loaded:
//   set -a; source apps/web/.env; set +a
//   pm2 start infra/ecosystem.config.cjs && pm2 save --force
module.exports = {
	apps: [
		{
			name: 'fudrouter-web',
			script: 'build/index.js',
			cwd: '/home/dwizzy/fudrouter/apps/web',
			env: {
				NODE_ENV: 'production',
				PORT: '3000',
				ORIGIN: 'http://127.0.0.1:3000',
				DATABASE_URL: process.env.DATABASE_URL,
				BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
				CREDENTIALS_MASTER_KEY: process.env.CREDENTIALS_MASTER_KEY
			}
		},
		{
			name: 'fudrouter-router',
			script: 'bin/fudrouter-router',
			cwd: '/home/dwizzy/fudrouter/services/router',
			env: {
				ROUTER_ADDR: '0.0.0.0:8100',
				DATABASE_URL: process.env.DATABASE_URL,
				CREDENTIALS_MASTER_KEY: process.env.CREDENTIALS_MASTER_KEY
			}
		}
	]
};
```

- [ ] **Step 4: Build + deploy under PM2**

```bash
cd /home/dwizzy/fudrouter/apps/web && npm run build
cd /home/dwizzy/fudrouter/services/router && go build -o bin/fudrouter-router .
cd /home/dwizzy/fudrouter
set -a; source apps/web/.env; set +a
pm2 delete fudrouter-web fudrouter-router 2>/dev/null; pm2 start infra/ecosystem.config.cjs
pm2 save --force
sleep 2
curl -s http://127.0.0.1:8100/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```
Expected: `{"ok":true,"service":"fudrouter-router"}` and `200`.

- [ ] **Step 5: E2E smoke test (the S0 acceptance gate — spec §11 + §14)**

`apps/web/src/e2e/smoke.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const ROUTER = process.env.SMOKE_ROUTER_URL ?? 'http://127.0.0.1:8100';
const WEB = process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000';

async function signUpAndKey(): Promise<{ key: string; apiKeyId: string; cookie: string }> {
	const { auth } = await import('$lib/server/auth');
	const { db } = await import('$lib/server/db');
	const { apiKey } = await import('$lib/server/db/schema');
	const { generateApiKey } = await import('$lib/server/keys');
	const { uuidv7 } = await import('uuidv7');
	const { eq } = await import('drizzle-orm');

	const email = `smoke-${randomUUID()}@example.com`;
	const res = await auth.api.signUpEmail({
		body: { email, password: 'smoke-test-password-1', name: 'Smoke', callbackURL: '/' }
	});
	if (!res.ok) throw new Error(`signup failed: ${res.status}`);

	const { user } = await import('$lib/server/db/auth.schema');
	const found = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
	const userId = found[0]?.id;
	if (!userId) throw new Error('user row not found after signup');

	const { key, prefix, keyHash } = generateApiKey();
	const id = uuidv7();
	await db.insert(apiKey).values({ id, userId, name: 'smoke', prefix, keyHash, limits: {} });

	// session cookie for the SSR check
	const signIn = await auth.api.signInEmail({
		body: { email, password: 'smoke-test-password-1', callbackURL: '/' }
	});
	const cookie = signIn.headers.get('set-cookie') ?? '';

	return { key, apiKeyId: id, cookie };
}

describe('S0 walking skeleton (E2E)', () => {
	it('signup → key → completion → request_log → usage SSR', { timeout: 60_000 }, async () => {
		const { key, apiKeyId, cookie } = await signUpAndKey();

		// 1. models list
		const models = await (await fetch(`${ROUTER}/v1/models`)).json();
		expect(models.data.length).toBeGreaterThan(0);
		const slug = models.data[0].id as string;

		// 2. real completion through the Go data plane
		const completion = await fetch(`${ROUTER}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: slug,
				messages: [{ role: 'user', content: 'Say the word: skeleton' }]
			})
		});
		expect(completion.status).toBe(200);
		const body = await completion.json();
		expect(body.usage?.total_tokens).toBeGreaterThan(0);

		// 3. revoked key → 401
		const { auth } = await import('$lib/server/auth');
		const { db } = await import('$lib/server/db');
		const { apiKey } = await import('$lib/server/db/schema');
		const { eq } = await import('drizzle-orm');
		const created = await db.select().from(apiKey).where(eq(apiKey.id, apiKeyId));
		await db.update(apiKey).set({ revokedAt: new Date() }).where(eq(apiKey.id, created[0].id));
		const revokedRes = await fetch(`${ROUTER}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
			body: JSON.stringify({ model: slug, messages: [{ role: 'user', content: 'x' }] })
		});
		expect(revokedRes.status).toBe(401);

		// 4. usage page renders SSR with the session cookie
		const usage = await fetch(`${WEB}/usage`, { headers: { cookie } });
		expect(usage.status).toBe(200);
		const html = await usage.text();
		expect(html).toContain(slug);
	});
});
```

Add script: `"test:e2e": "vitest run --config vitest.config.ts src/e2e"` — but the e2e spec must NOT run in normal `npm test` (CI has no router/DB). Exclude `src/e2e` from the unit test projects' include patterns in `vite.config.ts` (add `exclude: ['src/e2e/**']` to both projects' test configs), and create the e2e run command so it includes ONLY that dir. If the scaffold's vitest config makes this awkward, a dedicated `vitest.e2e.config.ts` extending the server project with `include: ['src/e2e/**/*.spec.ts']` is acceptable.

- [ ] **Step 6: Run the E2E gate (needs PM2 services from Step 4 running)**

```bash
cd /home/dwizzy/fudrouter/apps/web
set -a; source .env; set +a
npm run test:e2e
```
Expected: 1 test PASS — covers spec §14: signup/login works, real completion from seeded provider, request_log row with tokens + cost, usage page renders it, revoked key → 401.

- [ ] **Step 7: CI — add drizzle-kit check**

Add to `apps/web/package.json` scripts: `"db:check": "drizzle-kit check"`.
Add to `.github/workflows/ci.yml` web job after `npm ci`:

```yaml
      - run: npm run db:check --workspace apps/web
```

- [ ] **Step 8: Full local parity + commit**

```bash
cd /home/dwizzy/fudrouter
npm run check --workspace apps/web && npm run test --workspace apps/web
(cd services/router && go vet ./... && go test ./...)
git add apps/web infra services/router .github
git commit -m "feat(s0b): usage page, PM2 deploy, E2E acceptance smoke"
```

- [ ] **Step 9: Acceptance checklist (spec §14) — verify each live**

```bash
cd /home/dwizzy/fudrouter
echo "compose: $(docker compose -f infra/docker-compose.yml ps --format json 2>/dev/null | grep -c healthy)/2 healthy"
npm run check --workspace apps/web 2>&1 | tail -1
(cd services/router && go vet ./... && go test ./... 2>&1 | tail -1)
docker exec fudrouter-db psql -U fudrouter -d fudrouter -tAc "select count(*), sum(cost) from request_log;"
pm2 jlist | python3 -c "import sys,json; print([a['name'] for a in json.load(sys.stdin)])"
```
Expected: `2/2 healthy`; check 0 errors; go tests ok; request_log count > 0 with non-null sum; `['fudrouter-web', 'fudrouter-router']`.

---

## What this plan does NOT cover (deferred)

- **S0-C / S1**: lifting the ~2,343 LOC Go core (provider failover, circuit breaker, coalescing, metrics) from the backup; key-lookup cache; rate limits; routing strategies. The proxy here is a minimal single-provider forwarder.
- **fudrouter-app deletion** (spec §4.3 Phase C) — only after the S0-C lift is verified.
- Billing/ledger (S2), programs (S3), dashboards beyond /keys+/usage (S4), admin panel (S5).
- `limits` jsonb enforcement (column exists, nothing reads it yet).
- Valkey usage (container runs; nothing consumes it until S1/S2 queues).
