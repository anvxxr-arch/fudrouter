#!/usr/bin/env node
// scripts/backfill-credentials.mjs — split S0 provider credential blobs into
// per-account `credential` rows (docs/specs/2026-09-30-platform-schema.md §4).
//
// Why a script and not SQL: `provider.credentials_enc` is AES-256-GCM ciphertext
// and the accounts live INSIDE it. Only code holding CREDENTIALS_MASTER_KEY can
// see them, so the split cannot happen in a migration file. scripts/migrate.sh
// runs this between 0007 and the drop migration (0009), which refuses to drop
// the legacy column while any unsplit blob remains.
//
// Idempotent by construction: a provider whose connections already have
// credential rows is skipped entirely; each provider splits in one transaction.
//
// Envelope compatibility: this file duplicates the AES-256-GCM envelope from
// apps/web/src/lib/server/credentials.ts and services/router/internal/crypt
// (base64(iv[12] || ct || tag[16])) because a plain-node script cannot import
// TS. `scripts/backfill-credentials.test.ts` cross-checks both directions
// against credentials.ts — same "re-parse everything the other side mints"
// discipline as the API-key format.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

function masterKey() {
	const k = process.env.CREDENTIALS_MASTER_KEY;
	if (!k) throw new Error('CREDENTIALS_MASTER_KEY is not set');
	const buf = Buffer.from(k, 'base64');
	if (buf.length !== 32) throw new Error('CREDENTIALS_MASTER_KEY must be base64 of 32 bytes');
	return buf;
}

/**
 * @typedef {{ email?: string, access_token?: string, refresh_token?: string,
 *             id_token?: string, expired?: string }} S0Account
 * @typedef {{ api_key?: string, auth_kind?: string, protocol?: string,
 *             default_headers?: Record<string, string>, accounts?: S0Account[] }} S0Blob
 * @typedef {{ email?: string, access_token?: string, refresh_token?: string,
 *             id_token?: string, expired?: string, api_key?: string }} SecretPayload
 * @typedef {{ name: string, secret: SecretPayload, metadata: Record<string, string> }} CredentialRow
 */

/**
 * @param {Record<string, unknown>} plain
 * @returns {string}
 */
export function encryptJson(plain) {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

/**
 * @param {string} enc
 * @returns {Record<string, unknown>}
 */
export function decryptJson(enc) {
	const buf = Buffer.from(enc, 'base64');
	if (buf.length < 12 + 16) throw new Error('ciphertext too short');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(buf.length - 16);
	const ct = buf.subarray(12, buf.length - 16);
	const d = createDecipheriv('aes-256-gcm', masterKey(), iv);
	d.setAuthTag(tag);
	return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

/**
 * One S0 blob -> the rows it becomes.
 *
 * S0 blob shape (services/router/internal/proxy/pool.go `credentials`):
 *   { api_key?, auth_kind?, protocol?, default_headers?, accounts?: [{email,
 *     access_token, refresh_token, id_token, expired}] }
 * Shared fields (protocol/default_headers/auth_kind) belong to the CONNECTION
 * (spec §4) — they are not per-account — and each account becomes one
 * credential row carrying its own secrets.
 *
 * @param {S0Blob} blob
 * @returns {{ rows: CredentialRow[], connectionConfig: Record<string, unknown> }}
 */
export function splitBlob(blob) {
	const accounts = Array.isArray(blob.accounts) ? blob.accounts : [];
	/** @type {CredentialRow[]} */
	const rows = accounts.map((a, i) => {
		/** @type {Record<string, string>} */
		const metadata = {};
		if (a.email) metadata.email = a.email;
		return {
			name: a.email || `account-${i + 1}`,
			secret: { email: a.email ?? '', access_token: a.access_token ?? '', refresh_token: a.refresh_token ?? '', id_token: a.id_token ?? '', expired: a.expired ?? '' },
			metadata
		};
	});
	if (typeof blob.api_key === 'string' && blob.api_key !== '') {
		rows.push({ name: 'api-key', secret: { api_key: blob.api_key }, metadata: {} });
	}
	/** @type {Record<string, unknown>} */
	const connectionConfig = {};
	if (blob.protocol) connectionConfig.protocol = blob.protocol;
	if (blob.default_headers) connectionConfig.default_headers = blob.default_headers;
	if (blob.auth_kind) connectionConfig.auth_kind = blob.auth_kind;
	return { rows, connectionConfig };
}

// uuidv7, matching TS/Go id minting (spec §1). Plain node cannot import the
// `uuidv7` package's TS types but the runtime import is fine.
const { uuidv7 } = await import('uuidv7');

async function main() {
	const dsn = process.env.DATABASE_URL;
	if (!dsn) throw new Error('DATABASE_URL is required');
	const sql = postgres(dsn, { max: 1 });
	try {
		const providers = await sql`
			select p.id, p.credentials_enc
			from provider p
			where p.credentials_enc is not null and p.credentials_enc <> ''
			  and not exists (
				select 1 from connection c
				join credential cr on cr.connection_id = c.id
				where c.provider_id = p.id
			  )
			order by p.id`;
		let split = 0;
		for (const p of providers) {
			const blob = decryptJson(p.credentials_enc);
			const { rows, connectionConfig } = splitBlob(blob);
			if (rows.length === 0) {
				console.error(`provider ${p.id}: blob has neither accounts[] nor api_key — refusing to guess`);
				process.exitCode = 1;
				continue;
			}
			await sql.begin(async (tx) => {
				const [conn] = await tx`
					select id from connection
					where provider_id = ${p.id} and slug = 'default'`;
				if (!conn) throw new Error(`provider ${p.id}: no default connection (run 0007 first)`);
				if (Object.keys(connectionConfig).length > 0) {
					await tx`
						update connection set config = config || ${tx.json(/** @type {any} */ (connectionConfig))}, updated_at = now()
						where id = ${conn.id}`;
				}
				for (const r of rows) {
					await tx`
						insert into credential (id, connection_id, name, secret_enc, status, metadata)
						values (${'cred_' + uuidv7()}, ${conn.id}, ${r.name}, ${encryptJson(r.secret)},
						        'unknown', ${sql.json(r.metadata)})`;
				}
			});
			split += 1;
			console.log(`provider ${p.id}: ${rows.length} credential row(s)`);
		}
		console.log(`done: ${split} provider(s) split`);
		// Final safety: no blob may remain unsplit while credential rows exist
		// nowhere — 0009 keys its refusal off the same condition.
		const [left] = await sql`
			select count(*)::int as n from provider p
			where p.credentials_enc is not null and p.credentials_enc <> ''
			  and not exists (
				select 1 from connection c
				join credential cr on cr.connection_id = c.id
				where c.provider_id = p.id
			  )`;
		if (left.n > 0) {
			console.error(`${left.n} provider blob(s) still unsplit`);
			process.exitCode = 1;
		}
	} finally {
		await sql.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
