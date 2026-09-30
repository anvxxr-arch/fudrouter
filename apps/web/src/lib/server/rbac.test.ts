import { describe, expect, it } from 'vitest';
import {
	ALL_WORKSPACE_PERMISSIONS,
	WORKSPACE_ROLES,
	isWorkspacePermission,
	type WorkspacePermission
} from './rbac';

// The spec §2 matrix is a CONTRACT: the seeded workspace_role rows
// (0007_platform_backfill.sql) and the router's authorization decisions both
// follow it. A drift here (a new code added to one role but not the owner, a
// permission dropped from viewer) silently changes who can spend money or
// delete a workspace, so the matrix is pinned code-for-code.
describe('workspace permission codes', () => {
	it('is the complete spec §2 list, deduplicated', () => {
		expect(new Set(ALL_WORKSPACE_PERMISSIONS).size).toBe(ALL_WORKSPACE_PERMISSIONS.length);
		expect(ALL_WORKSPACE_PERMISSIONS).toEqual([
			'workspace.read',
			'workspace.write',
			'workspace.delete',
			'member.read',
			'member.invite',
			'member.remove',
			'project.read',
			'project.write',
			'project.delete',
			'key.read',
			'key.create',
			'key.rotate',
			'key.revoke',
			'routing.read',
			'routing.write',
			'alias.read',
			'alias.write',
			'request.read',
			'analytics.read',
			'usage.read',
			'budget.read',
			'budget.write',
			'limit.read',
			'limit.write',
			'alert.read',
			'alert.write',
			'webhook.read',
			'webhook.write',
			'billing.read',
			'billing.write'
		]);
	});
	it('guards membership by the closed list, not any string', () => {
		expect(isWorkspacePermission('key.create')).toBe(true);
		expect(isWorkspacePermission('key.destroy')).toBe(false);
		expect(isWorkspacePermission(42)).toBe(false);
	});
});

describe('builtin role matrix (spec §2)', () => {
	it('owner holds every code — the only role with workspace.delete', () => {
		expect(WORKSPACE_ROLES.owner).toEqual(ALL_WORKSPACE_PERMISSIONS);
		const deleters = Object.entries(WORKSPACE_ROLES)
			.filter(([, perms]) => perms.includes('workspace.delete'))
			.map(([role]) => role);
		expect(deleters).toEqual(['owner']);
	});
	it('admin holds everything except workspace.delete', () => {
		expect(new Set(WORKSPACE_ROLES.admin)).toEqual(
			new Set(ALL_WORKSPACE_PERMISSIONS.filter((p) => p !== 'workspace.delete'))
		);
	});
	it('developer: project/key/routing/alias + observability reads, no billing writes', () => {
		expect(new Set(WORKSPACE_ROLES.developer)).toEqual(
			new Set([
				'workspace.read',
				'member.read',
				'project.read',
				'project.write',
				'key.read',
				'key.create',
				'key.rotate',
				'key.revoke',
				'routing.read',
				'routing.write',
				'alias.read',
				'alias.write',
				'request.read',
				'analytics.read',
				'usage.read',
				'budget.read',
				'limit.read',
				'alert.read',
				'alert.write',
				'webhook.read',
				'webhook.write'
			])
		);
	});
	it('billing: money and reporting only', () => {
		expect(new Set(WORKSPACE_ROLES.billing)).toEqual(
			new Set([
				'workspace.read',
				'member.read',
				'project.read',
				'usage.read',
				'analytics.read',
				'billing.read',
				'billing.write'
			])
		);
	});
	it('viewer: reads only — every code ends in .read', () => {
		expect(new Set(WORKSPACE_ROLES.viewer)).toEqual(
			new Set([
				'workspace.read',
				'member.read',
				'project.read',
				'key.read',
				'routing.read',
				'alias.read',
				'request.read',
				'analytics.read',
				'usage.read',
				'budget.read',
				'limit.read',
				'alert.read',
				'webhook.read',
				'billing.read'
			])
		);
		for (const perm of WORKSPACE_ROLES.viewer) expect(perm.endsWith('.read')).toBe(true);
	});
	it('every role uses only known codes', () => {
		for (const [role, perms] of Object.entries(WORKSPACE_ROLES)) {
			for (const perm of perms) {
				expect(
					ALL_WORKSPACE_PERMISSIONS.includes(perm as WorkspacePermission),
					`${role} has unknown code ${perm}`
				).toBe(true);
			}
		}
	});
});
