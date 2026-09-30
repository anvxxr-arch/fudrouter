import { fail } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { incident, incidentUpdate } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { newId, ID_PREFIXES } from '$lib/server/id';
import { cleanField, parseEnum } from '$lib/server/admin-vocab';

const SEVERITIES = ['minor', 'major', 'critical'] as const;
const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const rows = await db
		.select({
			id: incident.id,
			title: incident.title,
			component: incident.component,
			severity: incident.severity,
			status: incident.status,
			startedAt: incident.startedAt,
			resolvedAt: incident.resolvedAt,
			createdAt: incident.createdAt
		})
		.from(incident)
		.orderBy(desc(incident.startedAt));
	const updates = await db
		.select({
			id: incidentUpdate.id,
			incidentId: incidentUpdate.incidentId,
			status: incidentUpdate.status,
			message: incidentUpdate.message,
			createdAt: incidentUpdate.createdAt
		})
		.from(incidentUpdate)
		.orderBy(desc(incidentUpdate.createdAt));
	const byIncident = new Map<string, typeof updates>();
	for (const u of updates) {
		const list = byIncident.get(u.incidentId);
		if (list) list.push(u);
		else byIncident.set(u.incidentId, [u]);
	}
	return {
		incidents: rows.map((r) => ({ ...r, updates: byIncident.get(r.id) ?? [] })),
		severities: SEVERITIES,
		statuses: STATUSES
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const title = cleanField(form.get('title'), 200);
		const component = cleanField(form.get('component'), 120);
		const severity = parseEnum(SEVERITIES, form.get('severity'));
		if (!title || !component || !severity) {
			return fail(400, { error: 'Title, component and severity are all required' });
		}
		// An incident always starts with a timeline entry — the status follows
		// the latest update, so a bare row would have nothing to show.
		await db.transaction(async (tx) => {
			const id = newId(ID_PREFIXES.incident);
			await tx.insert(incident).values({
				id,
				title,
				component,
				severity,
				status: 'investigating',
				startedAt: new Date()
			});
			await tx.insert(incidentUpdate).values({
				id: newId(ID_PREFIXES.incidentUpdate),
				incidentId: id,
				status: 'investigating',
				message: `Incident opened (${severity})`
			});
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'incident.create',
				resource: 'incident',
				resourceId: id,
				after: { title, component, severity, status: 'investigating' }
			});
		});
		return { created: title };
	},
	update: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const title = cleanField(form.get('title'), 200);
		const component = cleanField(form.get('component'), 120);
		const severity = parseEnum(SEVERITIES, form.get('severity'));
		if (!id || !title || !component || !severity) {
			return fail(400, { error: 'Title, component and severity are all required' });
		}
		const result = await db.transaction(async (tx) => {
			const updated = await tx
				.update(incident)
				.set({ title, component, severity })
				.where(eq(incident.id, id))
				.returning({ id: incident.id, title: incident.title, status: incident.status });
			const row = updated[0];
			if (!row) return null;
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'incident.update',
				resource: 'incident',
				resourceId: row.id,
				after: { title, component, severity }
			});
			return row;
		});
		if (!result) return fail(404, { error: 'Incident not found' });
		return { updated: result.id };
	},
	addTimeline: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const status = parseEnum(STATUSES, form.get('status'));
		const message = cleanField(form.get('message'), 2000);
		if (!id || !status || !message) {
			return fail(400, { error: 'Incident, status and message are all required' });
		}
		const result = await db.transaction(async (tx) => {
			const rows = await tx
				.update(incident)
				// The incident's status follows its latest update; resolution also
				// stamps resolved_at and reopening clears it (PRD §19).
				.set({
					status,
					resolvedAt: status === 'resolved' ? new Date() : null
				})
				.where(eq(incident.id, id))
				.returning({
					id: incident.id,
					title: incident.title,
					component: incident.component,
					severity: incident.severity
				});
			const row = rows[0];
			if (!row) return null;
			await tx.insert(incidentUpdate).values({
				id: newId(ID_PREFIXES.incidentUpdate),
				incidentId: row.id,
				status,
				message
			});
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'incident.update',
				resource: 'incident',
				resourceId: row.id,
				after: { status, message }
			});
			return row;
		});
		if (!result) return fail(404, { error: 'Incident not found' });
		return { updated: result.id };
	},
	delete: async ({ locals, request }) => {
		requireCap(locals, 'admin.ops');
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { error: 'Missing incident id' });
		const result = await db.transaction(async (tx) => {
			const deleted = await tx
				.delete(incident)
				.where(eq(incident.id, id))
				.returning({
					id: incident.id,
					title: incident.title,
					component: incident.component,
					severity: incident.severity,
					status: incident.status
				});
			const row = deleted[0];
			if (!row) return null;
			await writeAudit(tx, {
				actorUserId: locals.user?.id ?? null,
				action: 'incident.delete',
				resource: 'incident',
				resourceId: row.id,
				before: { ...row }
			});
			return row;
		});
		if (!result) return fail(404, { error: 'Incident not found' });
		return { deleted: result.id };
	}
};
