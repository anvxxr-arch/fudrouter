import { eq } from 'drizzle-orm';
import { db } from './db/index.ts';
import { systemSetting } from './db/schema.ts';

/**
 * Platform settings (PRD §105, §138) — a typed view over the
 * `system_setting` key/value table. Seeded keys are pinned in
 * `db/migrations/0007_platform_backfill.sql`; unknown keys read as `null`
 * rather than throwing, so a setting added later does not break older callers.
 */
export type SystemSettings = {
	default_routing_policy: { id: string } | null;
	platform_hard_limits: { rpm: number; tpm: number; concurrency: number } | null;
	retention: {
		request_metadata_days: number;
		request_content_days: number;
		system_events_days: number;
		audit_logs_days: number;
		// Terminal (`completed`/`failed`) `job` rows older than this are deleted;
		// 0/negative keeps them forever, same opt-in rule as the rest. Absent on
		// rows written before the key existed, so readers default it.
		job_days?: number;
	} | null;
	registration: { enabled: boolean } | null;
	maintenance: { enabled: boolean } | null;
	generic_passthrough: { enabled: boolean } | null;
};

export async function getSetting<K extends keyof SystemSettings>(
	key: K
): Promise<SystemSettings[K]> {
	const rows = await db
		.select({ value: systemSetting.value })
		.from(systemSetting)
		.where(eq(systemSetting.key, key))
		.limit(1);
	if (rows.length === 0) return null as SystemSettings[K];
	return rows[0].value as SystemSettings[K];
}

export async function setSetting<K extends keyof SystemSettings>(
	key: K,
	value: SystemSettings[K],
	updatedBy: string | null = null
): Promise<void> {
	await db
		.insert(systemSetting)
		.values({ key, value: value as Record<string, unknown>, updatedBy, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: systemSetting.key,
			set: { value: value as Record<string, unknown>, updatedBy, updatedAt: new Date() }
		});
}
