import { eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { getSetting } from '$lib/server/settings';
import { db } from '$lib/server/db';
import { environment, project, routingPolicy, workspace } from '$lib/server/db/schema';

/**
 * Routing hub (PRD §62): the resolution chain
 * `environment → project → workspace → platform default`, and every
 * `routing_policy` row with its scope. All three scope columns NULL means
 * platform-scope policy (spec §9). Read-only: mutations live on
 * `/admin/routing/policies`.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const policies = await db
		.select({
			id: routingPolicy.id,
			name: routingPolicy.name,
			strategy: routingPolicy.strategy,
			enabled: routingPolicy.enabled,
			maxAttempts: routingPolicy.maxAttempts,
			fallbackEnabled: routingPolicy.fallbackEnabled,
			workspaceId: routingPolicy.workspaceId,
			projectId: routingPolicy.projectId,
			environmentId: routingPolicy.environmentId
		})
		.from(routingPolicy)
		.orderBy(routingPolicy.name);
	const [workspaces, projects, envs, defaultPolicy] = await Promise.all([
		db.select({ id: workspace.id, name: workspace.name }).from(workspace).orderBy(workspace.name),
		db
			.select({
				id: project.id,
				name: project.name,
				workspaceId: project.workspaceId
			})
			.from(project)
			.orderBy(project.name),
		db
			.select({
				id: environment.id,
				name: environment.name,
				projectId: environment.projectId,
				routingPolicyId: environment.routingPolicyId
			})
			.from(environment)
			.orderBy(environment.name),
		getSetting('default_routing_policy')
	]);
	const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
	const projById = new Map(projects.map((p) => [p.id, p]));
	const envName = new Map(envs.map((e) => [e.id, e.name]));
	const policyById = new Map(policies.map((p) => [p.id, p]));
	const rows = policies.map((p) => {
		const scope = p.environmentId
			? ('environment' as const)
			: p.projectId
				? ('project' as const)
				: p.workspaceId
					? ('workspace' as const)
					: ('platform' as const);
		let scopeName = 'platform';
		if (p.environmentId && envName.has(p.environmentId)) {
			const env = envs.find((e) => e.id === p.environmentId);
			const projName = env ? (projById.get(env.projectId)?.name ?? env.projectId) : '';
			scopeName = `environment: ${envName.get(p.environmentId)} (${projName})`;
		} else if (p.projectId && projById.has(p.projectId)) {
			scopeName = `project: ${projById.get(p.projectId)?.name}`;
		} else if (p.workspaceId && wsName.has(p.workspaceId)) {
			scopeName = `workspace: ${wsName.get(p.workspaceId)}`;
		}
		return { ...p, scope, scopeName };
	});
	// The chain, one row per environment: who resolves where before the
	// platform default applies.
	const chain = envs.map((e) => {
		const proj = projById.get(e.projectId);
		return {
			environment: e.name,
			project: proj?.name ?? e.projectId,
			workspace: proj ? (wsName.get(proj.workspaceId) ?? proj.workspaceId) : '—',
			policyId: e.routingPolicyId,
			policyName: e.routingPolicyId ? (policyById.get(e.routingPolicyId)?.name ?? null) : null
		};
	});
	const platformDefaultId = defaultPolicy?.id ?? null;
	return {
		policies: rows,
		chain,
		platformDefaultId,
		platformDefaultName: platformDefaultId
			? (policyById.get(platformDefaultId)?.name ?? platformDefaultId)
			: null
	};
};
