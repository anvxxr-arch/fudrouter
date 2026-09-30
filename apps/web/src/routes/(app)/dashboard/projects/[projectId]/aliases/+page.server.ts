import { error, fail } from '@sveltejs/kit';
import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { model, modelAlias, modelAliasTarget, project } from '$lib/server/db/schema';
import { currentWorkspaceId, requireMemberPermission } from '$lib/server/rbac';
import { writeAudit } from '$lib/server/audit';
import { bumpVersion } from '$lib/server/vk';
import { ID_PREFIXES, newId } from '$lib/server/id';
import { parseAliasForm, targetRows, type AliasFormValue } from '$lib/alias-form';
import { requireCap } from '$lib/server/roles';

/** Alias scope as the form posts it. Global virtuals are never created here. */
type AliasScope = 'project' | 'workspace';

export interface AliasTargetView {
	modelId: string;
	slug: string;
	status: string;
	developer: string | null;
	position: number;
}
export interface AliasView {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	scope: AliasScope | 'global';
	targets: AliasTargetView[];
}
export interface ModelOption {
	id: string;
	slug: string;
	name: string;
	status: string;
	developer: string | null;
}

/**
 * The alias set a project sees (PRD §35, spec §5): its own project aliases,
 * then workspace aliases, then the global `fudrouter/*` virtuals. Resolution
 * order project → workspace → global means the lists shown here are exactly
 * what a request named after one of these rows would hit.
 */
async function loadAliases(projectId: string, workspaceId: string): Promise<AliasView[]> {
	const aliasRows = await db
		.select({
			id: modelAlias.id,
			name: modelAlias.name,
			description: modelAlias.description,
			enabled: modelAlias.enabled,
			workspaceId: modelAlias.workspaceId,
			projectId: modelAlias.projectId
		})
		.from(modelAlias)
		.where(
			or(
				eq(modelAlias.projectId, projectId),
				and(eq(modelAlias.workspaceId, workspaceId), isNull(modelAlias.projectId)),
				isNull(modelAlias.workspaceId)
			)
		)
		.orderBy(asc(modelAlias.name));
	if (aliasRows.length === 0) return [];
	// Targets are a separate ordered list; joining model once here beats a
	// query per alias and keeps `slug`/`status` in sync with the catalog.
	const joins = await db
		.select({
			aliasId: modelAliasTarget.aliasId,
			modelId: modelAliasTarget.modelId,
			position: modelAliasTarget.position,
			slug: model.slug,
			status: model.status,
			developer: model.developer
		})
		.from(modelAliasTarget)
		.innerJoin(model, eq(model.id, modelAliasTarget.modelId))
		.where(inArray(modelAliasTarget.aliasId, aliasRows.map((a) => a.id)))
		.orderBy(asc(modelAliasTarget.aliasId), asc(modelAliasTarget.position));
	const byAlias = new Map<string, AliasTargetView[]>();
	for (const j of joins) {
		const list = byAlias.get(j.aliasId) ?? [];
		list.push({
			modelId: j.modelId,
			slug: j.slug,
			status: j.status,
			developer: j.developer,
			position: j.position
		});
		byAlias.set(j.aliasId, list);
	}
	return aliasRows.map((a) => ({
		id: a.id,
		name: a.name,
		description: a.description,
		enabled: a.enabled,
		scope: a.workspaceId === null ? 'global' : a.projectId === null ? 'workspace' : 'project',
		targets: byAlias.get(a.id) ?? []
	}));
}

/** Shared create/update validation once the write permission is already held. */
async function validateTargets(value: AliasFormValue): Promise<string | null> {
	const known = await db
		.select({ id: model.id })
		.from(model)
		.where(inArray(model.id, value.targets));
	if (known.length !== value.targets.length) return 'One or more target models do not exist.';
	return null;
}

/** The project this page is scoped to, or 404 — params alone never authorize. */
async function requireProject(params: { projectId: string }, workspaceId: string): Promise<void> {
	const [proj] = await db
		.select({ id: project.id })
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
}

function scopeField(form: FormData): AliasScope | { error: string } {
	const raw = String(form.get('scope') ?? '');
	if (raw !== 'project' && raw !== 'workspace') {
		return { error: 'Scope must be project or workspace' };
	}
	return raw;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	// The hook gates this route; this is the second layer, as on /admin.
	requireCap(locals, 'member');
	const workspaceId = await currentWorkspaceId(locals);
	if (!workspaceId) error(404, 'Project not found');
	await requireMemberPermission(locals, workspaceId, 'alias.read');
	const [proj] = await db
		.select({ id: project.id, name: project.name, slug: project.slug })
		.from(project)
		.where(and(eq(project.id, params.projectId), eq(project.workspaceId, workspaceId)))
		.limit(1);
	if (!proj) error(404, 'Project not found');
	const [aliases, models] = await Promise.all([
		loadAliases(proj.id, workspaceId),
		db
			.select({
				id: model.id,
				slug: model.slug,
				name: model.name,
				status: model.status,
				developer: model.developer
			})
			.from(model)
			// Disabled models cannot serve traffic, so they are not pickable.
			// Deprecated/sunset ones stay listed — they are exactly the targets a
			// fallback chain should move away from, with a visible warning.
			.where(ne(model.status, 'disabled'))
			.orderBy(asc(model.slug))
	]);
	return { project: proj, aliases, models };
};

export const actions: Actions = {
	create: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) error(404, 'Project not found');
		await requireMemberPermission(locals, workspaceId, 'alias.write');
		const form = await request.formData();
		const parsed = parseAliasForm((k) => form.get(k));
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const scopeFieldResult = scopeField(form);
		// typeof narrows (not `in`): AliasScope is a string union, and `in`
		// demands an object right-hand side.
		if (typeof scopeFieldResult !== 'string') {
			return fail(400, { error: scopeFieldResult.error });
		}
		const scope = scopeFieldResult;
		// Name collisions are scoped (spec §5): project and workspace aliases may
		// share a name — the project one shadows the workspace one on purpose.
		const collision = await db
			.select({ id: modelAlias.id })
			.from(modelAlias)
			.where(
				scope === 'project'
					? and(eq(modelAlias.projectId, params.projectId), eq(modelAlias.name, parsed.value.name))
					: and(
							eq(modelAlias.workspaceId, workspaceId),
							isNull(modelAlias.projectId),
							eq(modelAlias.name, parsed.value.name)
						)
			)
			.limit(1);
		if (collision.length > 0) {
			return fail(409, {
				error: `An alias named “${parsed.value.name}” already exists in this ${scope}.`
			});
		}
		const invalid = await validateTargets(parsed.value);
		if (invalid) return fail(400, { error: invalid });
		await requireProject(params, workspaceId);
		const aliasId = newId(ID_PREFIXES.modelAlias);
		const value = parsed.value;
		await db.transaction(async (tx) => {
			await tx.insert(modelAlias).values({
				id: aliasId,
				workspaceId,
				projectId: scope === 'project' ? params.projectId : null,
				name: value.name,
				description: value.description || null,
				enabled: value.enabled
			});
			await tx.insert(modelAliasTarget).values(targetRows(aliasId, value.targets));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'alias.create',
				resource: 'model_alias',
				resourceId: aliasId,
				workspaceId,
				after: { ...value, scope }
			});
		});
		await bumpVersion('model_alias');
		return { created: value.name };
	},
	update: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) error(404, 'Project not found');
		await requireMemberPermission(locals, workspaceId, 'alias.write');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing alias id' });
		const [existing] = await db
			.select({
				id: modelAlias.id,
				name: modelAlias.name,
				description: modelAlias.description,
				enabled: modelAlias.enabled,
				workspaceId: modelAlias.workspaceId,
				projectId: modelAlias.projectId
			})
			.from(modelAlias)
			.where(eq(modelAlias.id, id))
			.limit(1);
		if (!existing) return fail(404, { error: 'Alias not found' });
		// Global virtuals (workspace_id NULL) are seeded and router-owned (spec §5).
		if (existing.workspaceId === null) {
			return fail(403, { error: 'Global virtual aliases are read-only.' });
		}
		if (existing.projectId !== params.projectId && existing.projectId !== null) {
			return fail(404, { error: 'Alias not found' });
		}
		const parsed = parseAliasForm((k) => form.get(k));
		if (!parsed.ok) return fail(400, { error: parsed.error });
		const scopeFieldResult = scopeField(form);
		if (typeof scopeFieldResult !== 'string') {
			return fail(400, { error: scopeFieldResult.error });
		}
		const scope = scopeFieldResult;
		const collision = await db
			.select({ id: modelAlias.id })
			.from(modelAlias)
			.where(
				and(
					scope === 'project'
						? and(eq(modelAlias.projectId, params.projectId), eq(modelAlias.name, parsed.value.name))
						: and(
								eq(modelAlias.workspaceId, workspaceId),
								isNull(modelAlias.projectId),
								eq(modelAlias.name, parsed.value.name)
							),
					ne(modelAlias.id, id)
				)
			)
			.limit(1);
		if (collision.length > 0) {
			return fail(409, {
				error: `An alias named “${parsed.value.name}” already exists in this ${scope}.`
			});
		}
		const invalid = await validateTargets(parsed.value);
		if (invalid) return fail(400, { error: invalid });
		await requireProject(params, workspaceId);
		const value = parsed.value;
		await db.transaction(async (tx) => {
			await tx
				.update(modelAlias)
				.set({
					// Scope is one of "the same fields" — moving workspace ↔ project is
					// a normal re-home, and the collision check above ran in the
					// destination scope.
					workspaceId,
					projectId: scope === 'project' ? params.projectId : null,
					name: value.name,
					description: value.description || null,
					enabled: value.enabled,
					updatedAt: new Date()
				})
				.where(eq(modelAlias.id, id));
			// Target rewrite: the ordered list is one value, so it is replaced
			// wholesale — delete + reinsert keeps positions 1..N with no splices.
			await tx.delete(modelAliasTarget).where(eq(modelAliasTarget.aliasId, id));
			await tx.insert(modelAliasTarget).values(targetRows(id, value.targets));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'alias.update',
				resource: 'model_alias',
				resourceId: id,
				workspaceId,
				before: {
					name: existing.name,
					description: existing.description,
					enabled: existing.enabled,
					scope: existing.projectId === null ? 'workspace' : 'project'
				},
				after: { ...value, scope }
			});
		});
		await bumpVersion('model_alias');
		return { updated: value.name };
	},
	delete: async ({ locals, request, params }) => {
		requireCap(locals, 'member');
		const workspaceId = await currentWorkspaceId(locals);
		if (!workspaceId) error(404, 'Project not found');
		await requireMemberPermission(locals, workspaceId, 'alias.write');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing alias id' });
		const [existing] = await db
			.select({
				id: modelAlias.id,
				name: modelAlias.name,
				description: modelAlias.description,
				enabled: modelAlias.enabled,
				workspaceId: modelAlias.workspaceId,
				projectId: modelAlias.projectId
			})
			.from(modelAlias)
			.where(eq(modelAlias.id, id))
			.limit(1);
		if (!existing) return fail(404, { error: 'Alias not found' });
		if (existing.workspaceId === null) {
			return fail(403, { error: 'Global virtual aliases are read-only.' });
		}
		if (existing.projectId !== params.projectId && existing.projectId !== null) {
			return fail(404, { error: 'Alias not found' });
		}
		await db.transaction(async (tx) => {
			// model_alias_target cascades with the alias, but the audit row must
			// carry what the targets were before the delete.
			const targets = await tx
				.select({ modelId: modelAliasTarget.modelId, position: modelAliasTarget.position })
				.from(modelAliasTarget)
				.where(eq(modelAliasTarget.aliasId, id))
				.orderBy(asc(modelAliasTarget.position));
			await tx.delete(modelAlias).where(eq(modelAlias.id, id));
			await writeAudit(tx, {
				actorUserId: locals.user!.id,
				action: 'alias.delete',
				resource: 'model_alias',
				resourceId: id,
				workspaceId,
				before: {
					name: existing.name,
					description: existing.description,
					enabled: existing.enabled,
					scope: existing.projectId === null ? 'workspace' : 'project',
					targets
				}
			});
		});
		await bumpVersion('model_alias');
		return { deleted: existing.name };
	}
};
