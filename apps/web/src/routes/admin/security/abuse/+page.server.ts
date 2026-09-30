import { inArray } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import {
	SIGNAL_KINDS,
	evaluateSecuritySignals,
	type SecurityRuleRow
} from '$lib/server/admin-signals';
import {
	KEY_LIFECYCLE_ACTIONS,
	WINDOW_HOURS,
	buildWindowStats,
	matchedKeyLifecycleActions
} from '$lib/server/admin-security-store';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { securityRule } from '$lib/server/db/schema';
/**
 * The abuse dashboard (PRD §70): SQL window stats in, threshold rules applied,
 * fired signals out. Nothing here phones out or classifies intent — the only
 * logic is `evaluateSecuritySignals` comparing counts to thresholds.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.audit');
	const rows = await db
		.select({
			id: securityRule.id,
			name: securityRule.name,
			kind: securityRule.kind,
			config: securityRule.config,
			enabled: securityRule.enabled,
			action: securityRule.action
		})
		.from(securityRule)
		.where(inArray(securityRule.kind, [...SIGNAL_KINDS]))
		.orderBy(securityRule.name);
	const rules: SecurityRuleRow[] = rows.map((r) => ({
		...r,
		kind: r.kind as SecurityRuleRow['kind'],
		action: r.action as SecurityRuleRow['action']
	}));
	const windows = await buildWindowStats(db);
	const matchedActions = await matchedKeyLifecycleActions(db);
	const signals = evaluateSecuritySignals(rules, windows);
	return {
		signals,
		windows,
		ruleCount: rules.length,
		enabledRuleCount: rules.filter((r) => r.enabled).length,
		/** Which of `watchedActions` actually occurred in the trailing window. */
		matchedActions,
		/** The key-lifecycle `audit_log` actions this dashboard counts. */
		watchedActions: KEY_LIFECYCLE_ACTIONS,
		windowHours: WINDOW_HOURS
	};
};
