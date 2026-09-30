import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { apiKey, project } from '$lib/server/db/schema';
import { parseMicros } from '$lib/money';

/**
 * Shared lookups and form parsing for the project API-key pages.
 *
 * Every key read is scoped by project AND workspace and answers
 * `error(404, 'Key not found')` — an id alone must never resolve another
 * tenant's row, and the 404 does not leak whether the id exists elsewhere.
 */

/** The project, scoped by workspace. */
export async function scopedProject(projectId: string, workspaceId: string) {
	const [proj] = await db
		.select({ id: project.id, name: project.name })
		.from(project)
		.where(and(eq(project.id, projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	return proj;
}

/**
 * One key, scoped by project and workspace. Explicit columns: `keyHash` is the
 * stored secret material and MUST never reach page data.
 */
export async function scopedKey(keyId: string, projectId: string, workspaceId: string) {
	const [row] = await db
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			status: apiKey.status,
			policy: apiKey.policy,
			environmentId: apiKey.environmentId,
			createdAt: apiKey.createdAt,
			lastUsedAt: apiKey.lastUsedAt,
			expiresAt: apiKey.expiresAt,
			revokedAt: apiKey.revokedAt
		})
		.from(apiKey)
		.where(
			and(
				eq(apiKey.id, keyId),
				eq(apiKey.projectId, projectId),
				eq(apiKey.workspaceId, workspaceId)
			)
		)
		.limit(1);
	if (!row) error(404, 'Key not found');
	return row;
}

/**
 * api_key.policy (spec §3) as the Go data plane reads it (internal/keys
 * KeyPolicy): every field optional — a MISSING key means "inherit from the
 * scope chain" (spec §7), so an empty form field is omitted, never zeroed.
 */
export type KeyPolicy = {
	endpoints?: string[];
	models?: string[];
	aliases?: string[];
	ip_allowlist?: string[];
	rpm?: number;
	tpm?: number;
	concurrency?: number;
	daily_spend_micro?: number;
	monthly_spend_micro?: number;
};

export type PolicyParse = { ok: true; policy: KeyPolicy } | { ok: false; error: string };

/** Comma-separated allowlist input → trimmed, non-empty entries. */
function csv(raw: unknown): string[] {
	return String(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Build the policy from the create form. Invalid input fails, never guesses. */
export function policyFromForm(form: FormData): PolicyParse {
	const policy: KeyPolicy = {};

	const endpoints = csv(form.get('endpoints'));
	if (endpoints.length) policy.endpoints = endpoints;
	const models = csv(form.get('models'));
	if (models.length) policy.models = models;
	const aliases = csv(form.get('aliases'));
	if (aliases.length) policy.aliases = aliases;
	const ipAllowlist = csv(form.get('ip_allowlist'));
	if (ipAllowlist.length) policy.ip_allowlist = ipAllowlist;

	for (const field of ['rpm', 'tpm', 'concurrency'] as const) {
		const raw = String(form.get(field) ?? '').trim();
		if (!raw) continue;
		if (!/^\d+$/.test(raw)) return { ok: false, error: `${field} must be a whole number` };
		const value = Number(raw);
		if (!Number.isSafeInteger(value)) return { ok: false, error: `${field} is too large` };
		policy[field] = value;
	}

	for (const [field, formName, label] of [
		['daily_spend_micro', 'dailySpend', 'Daily spend'],
		['monthly_spend_micro', 'monthlySpend', 'Monthly spend']
	] as const) {
		const raw = String(form.get(formName) ?? '').trim();
		if (!raw) continue;
		const micros = parseMicros(raw);
		if (micros === null) {
			return { ok: false, error: `${label} must be a plain amount like 12.50` };
		}
		if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
			return { ok: false, error: `${label} is too large` };
		}
		policy[field] = Number(micros);
	}

	return { ok: true, policy };
}

/**
 * Typed confirmation (contract): the `confirm` field must carry the key's
 * exact name before any mutation. Returns the failure message or null.
 */
export function confirmError(form: FormData, name: string): string | null {
	const confirm = String(form.get('confirm') ?? '').trim();
	return confirm === name ? null : `Type the key name “${name}” exactly to confirm`;
}
