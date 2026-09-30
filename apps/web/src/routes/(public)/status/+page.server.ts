import { desc, asc, ne, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { incident } from '$lib/server/db/schema';
import { newId } from '$lib/server/id';
import {
	COMPONENT_DESCRIPTIONS,
	COMPONENT_LABELS,
	COMPONENT_STATES,
	STATE_LABELS,
	STATUS_COMPONENTS,
	componentOf,
	stateFor,
	type ComponentState,
	type StatusComponent
} from '$lib/status';

/** Incident status words as shown to visitors (PRD §19 timeline vocabulary). */
const STATUS_LABELS: Record<string, string> = {
	investigating: 'Investigating',
	identified: 'Identified',
	monitoring: 'Monitoring',
	resolved: 'Resolved'
};

type Probe = {
	/** True when /health answered OK (and /v1/models was reachable enough to list). */
	ok: boolean;
	/** `/health` answered 503 naming the database as the failure. */
	dbUnreachable: boolean;
	/** Human-readable probe failure, or null when healthy. */
	error: string | null;
	service: string;
	/** Model count from GET /v1/models, or null when it could not be read. */
	models: number | null;
	latencyMs: number;
	checkedAt: string;
};

type IncidentRow = {
	id: string;
	title: string;
	severity: string;
	status: string;
	statusLabel: string;
	componentLabel: string;
	startedAt: string;
	resolvedAt: string | null;
};

type ComponentRow = {
	key: StatusComponent;
	label: string;
	description: string;
	state: ComponentState | null;
	stateLabel: string;
	basis: string;
};

/**
 * Real liveness probe against the Go data plane. A short timeout keeps the
 * page snappy when the router is down. `error: 'database unreachable'` on a
 * 503 body is a distinct failure: the gateway answered, but its own health
 * check reports the database as down.
 */
async function probeDataPlane(): Promise<Probe> {
	const base = env.ROUTER_BASE_URL ?? 'http://127.0.0.1:8100';
	const started = Date.now();
	const finish = (partial: Partial<Probe>): Probe => ({
		ok: false,
		dbUnreachable: false,
		error: null,
		service: '',
		models: null,
		latencyMs: Date.now() - started,
		checkedAt: new Date().toISOString(),
		...partial
	});
	let health: Response;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 4000);
		health = await fetch(`${base}/health`, { signal: ctrl.signal });
		clearTimeout(timer);
	} catch (e) {
		return finish({
			error: e instanceof Error && e.name === 'AbortError' ? 'timed out after 4s' : 'unreachable'
		});
	}
	if (!health.ok) {
		let body: { error?: string } = {};
		try {
			body = await health.json();
		} catch {
			/* non-JSON error body: fall through with the status code */
		}
		const detail = String(body.error ?? '').toLowerCase();
		return finish({
			error: body.error ?? `HTTP ${health.status}`,
			dbUnreachable: detail.includes('database')
		});
	}
	let service = '';
	try {
		service = (await health.json()).service ?? '';
	} catch {
		/* a 200 with an unreadable body is still an answer */
	}
	let models: number | null = null;
	try {
		const list = await fetch(`${base}/v1/models`);
		if (list.ok) models = ((await list.json()).data ?? []).length;
	} catch {
		models = null;
	}
	return finish({ ok: true, service, models });
}

/** The worse of two known states; null means "no data", never "operational". */
function worse(a: ComponentState | null, b: ComponentState | null): ComponentState | null {
	if (a === null) return b;
	if (b === null) return a;
	return COMPONENT_STATES.indexOf(a) >= COMPONENT_STATES.indexOf(b) ? a : b;
}

/**
 * What the live probe says about a component — only for the rows it actually
 * speaks to. `GET /health` covers the gateway and (through its health check)
 * the database; the dashboard is proven by this page rendering at all.
 * Authentication and billing have no independent probe: null = not probed.
 */
function probeState(key: StatusComponent, probe: Probe): ComponentState | null {
	if (key === 'dashboard') return 'operational';
	if (key === 'gateway') return probe.ok ? 'operational' : 'major-outage';
	if (key === 'database-services') {
		if (probe.ok) return 'operational';
		return probe.dbUnreachable ? 'major-outage' : null;
	}
	return null;
}

const BASIS: Record<StatusComponent, string> = {
	gateway: 'Live probe and open incidents.',
	dashboard: 'This page rendered — the control plane is up — with open incidents overlaid.',
	authentication: 'Open incidents only — there is no independent sign-in probe.',
	billing: 'Open incidents only — there is no independent billing probe.',
	'database-services': 'Live probe and open incidents.',
	'major-providers': 'Open incidents only — upstream trouble is reported through incidents.'
};

export const load = async () => {
	const probe = await probeDataPlane();

	// DB reads degrade to "unknown data" (PRD §122), never a 500: the probe
	// above is the part of this page that must survive a database outage.
	let incidents: IncidentRow[] | null = null;
	let openIncidents: { component: StatusComponent; severity: string; status: string }[] | null =
		null;
	let dbErrorRequestId: string | null = null;
	try {
		const cols = {
			id: incident.id,
			title: incident.title,
			severity: incident.severity,
			status: incident.status,
			component: incident.component,
			startedAt: incident.startedAt,
			resolvedAt: incident.resolvedAt
		};
		const open = await db.select(cols).from(incident).where(ne(incident.status, 'resolved'));
		openIncidents = open.map((r) => ({
			component: componentOf(r.component),
			severity: r.severity,
			status: r.status
		}));
		const rows = await db
			.select(cols)
			.from(incident)
			// Newest first, open first: an active incident outranks history.
			.orderBy(
				asc(sql`case when ${incident.status} = 'resolved' then 1 else 0 end`),
				desc(incident.startedAt)
			)
			.limit(50);
		incidents = rows.map((r) => ({
			id: r.id,
			title: r.title,
			severity: r.severity,
			status: r.status,
			statusLabel: STATUS_LABELS[r.status] ?? r.status.charAt(0).toUpperCase() + r.status.slice(1),
			componentLabel: COMPONENT_LABELS[componentOf(r.component)],
			startedAt: r.startedAt.toISOString(),
			resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null
		}));
	} catch {
		incidents = null;
		openIncidents = null;
		dbErrorRequestId = newId('req_');
	}

	// Component derivation (PRD §19), in two steps: `stateFor` rolls open
	// incidents up per component, then the live probe is overlaid on the rows
	// it speaks to — where both speak, the worse state wins.
	const components: ComponentRow[] = STATUS_COMPONENTS.map((key) => {
		const fromIncidents = openIncidents === null ? null : stateFor(key, openIncidents);
		const state = worse(fromIncidents, probeState(key, probe));
		return {
			key,
			label: COMPONENT_LABELS[key],
			description: COMPONENT_DESCRIPTIONS[key],
			state,
			stateLabel: state ? STATE_LABELS[state] : 'Unknown',
			basis: BASIS[key]
		};
	});
	let overall: ComponentState | null = null;
	for (const c of components) overall = worse(overall, c.state);

	return {
		probe,
		incidents,
		dbErrorRequestId,
		components,
		overall: {
			state: overall,
			label: overall ? STATE_LABELS[overall] : 'Unknown'
		}
	};
};
