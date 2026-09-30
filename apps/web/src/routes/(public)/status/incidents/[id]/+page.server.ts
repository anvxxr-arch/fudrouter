import { asc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { incident, incidentUpdate } from '$lib/server/db/schema';
import { publicError } from '$lib/server/public-error';
import { COMPONENT_LABELS, componentOf } from '$lib/status';

/** PRD §19 timeline vocabulary — matches what the status page list shows. */
const STATUS_LABELS: Record<string, string> = {
	investigating: 'Investigating',
	identified: 'Identified',
	monitoring: 'Monitoring',
	resolved: 'Resolved'
};

export const load: PageServerLoad = async ({ params }) => {
	type Update = { status: string; message: string; createdAt: Date };
	let row:
		| {
				id: string;
				title: string;
				component: string;
				severity: string;
				status: string;
				startedAt: Date;
				resolvedAt: Date | null;
		  }
		| undefined;
	let updates: Update[] = [];
	try {
		const rows = await db.select().from(incident).where(eq(incident.id, params.id)).limit(1);
		row = rows[0];
		if (row) {
			updates = await db
				.select({
					status: incidentUpdate.status,
					message: incidentUpdate.message,
					createdAt: incidentUpdate.createdAt
				})
				.from(incidentUpdate)
				.where(eq(incidentUpdate.incidentId, params.id))
				// Chronological: the timeline reads top to bottom as it happened.
				.orderBy(asc(incidentUpdate.createdAt));
		}
	} catch {
		// The database being down is NOT "incident not found" — say which it is.
		throw publicError(503, 'Incident unavailable', {
			why: 'The incident database could not be read just now.',
			action: 'Reload in a moment, or check the status page for live component health.'
		});
	}
	if (!row) {
		throw publicError(404, 'Incident not found', {
			why: 'No incident with that ID exists — it may have been mistyped or never filed.',
			action: 'Back to the status page.'
		});
	}

	const component = componentOf(row.component);
	const label = (s: string) => STATUS_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

	// An incident with no update rows gets one honest synthesized row from its
	// own fields — clearly marked as unrecorded, never dressed up as history.
	const timeline =
		updates.length > 0
			? updates.map((u) => ({
					status: u.status,
					statusLabel: label(u.status),
					message: u.message,
					createdAt: u.createdAt.toISOString(),
					synthesized: false
				}))
			: [
					{
						status: row.status,
						statusLabel: label(row.status),
						message: 'A step-by-step timeline was not recorded for this incident.',
						createdAt: (row.resolvedAt ?? row.startedAt).toISOString(),
						synthesized: true
					}
				];

	return {
		incident: {
			id: row.id,
			title: row.title,
			severity: row.severity,
			component,
			componentLabel: COMPONENT_LABELS[component],
			componentRaw: row.component,
			status: row.status,
			statusLabel: label(row.status),
			startedAt: row.startedAt.toISOString(),
			resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null
		},
		timeline
	};
};
