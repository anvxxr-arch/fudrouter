/**
 * Status page components (PRD §19) — the six components and their vocabulary.
 *
 * Pure data + classification so the status page (and its test) never hardcodes
 * the component list or the states twice. `componentOf` maps the free-text
 * `incident.component` column onto one of the six PRD §19 components; anything
 * unknown lands on `major-providers` rather than being dropped — an incident we
 * cannot classify still has to be shown.
 */
export const STATUS_COMPONENTS = [
	'gateway',
	'dashboard',
	'authentication',
	'billing',
	'database-services',
	'major-providers'
] as const;
export type StatusComponent = (typeof STATUS_COMPONENTS)[number];

export const COMPONENT_LABELS: Record<StatusComponent, string> = {
	gateway: 'Gateway',
	dashboard: 'Dashboard',
	authentication: 'Authentication',
	billing: 'Billing',
	'database-services': 'Database-facing services',
	'major-providers': 'Major providers'
};

export const COMPONENT_DESCRIPTIONS: Record<StatusComponent, string> = {
	gateway: 'The data plane that answers /v1 calls.',
	dashboard: 'The control plane — console, API keys, usage.',
	authentication: 'Sign-in, sessions and key validation.',
	billing: 'Balance, ledger and per-request metering.',
	'database-services': 'PostgreSQL and Valkey.',
	'major-providers': 'The upstream AI providers the network routes to.'
};

export const COMPONENT_STATES = [
	'operational',
	'degraded',
	'partial-outage',
	'major-outage',
	'maintenance'
] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

export const STATE_LABELS: Record<ComponentState, string> = {
	operational: 'Operational',
	degraded: 'Degraded',
	'partial-outage': 'Partial Outage',
	'major-outage': 'Major Outage',
	maintenance: 'Maintenance'
};

/** Severity ordering used to roll incident severities up to a component state. */
const SEVERITY_STATE: Record<string, ComponentState> = {
	minor: 'degraded',
	major: 'partial-outage',
	critical: 'major-outage'
};

export function componentOf(raw: string): StatusComponent {
	const s = raw.toLowerCase();
	if (s.includes('gateway') || s.includes('router') || s.includes('data plane')) return 'gateway';
	if (s.includes('dashboard') || s.includes('console') || s.includes('control plane'))
		return 'dashboard';
	if (s.includes('auth') || s.includes('session') || s.includes('sign')) return 'authentication';
	if (s.includes('billing') || s.includes('ledger') || s.includes('meter')) return 'billing';
	if (s.includes('database') || s.includes('postgres') || s.includes('valkey') || s.includes('db'))
		return 'database-services';
	return 'major-providers';
}

export interface OpenIncident {
	component: StatusComponent;
	severity: string;
	status: string;
}

/**
 * Component state from open (non-resolved) incidents: no open incident for the
 * component is `operational`. The live probe result is applied by the page (it
 * speaks only to Gateway/Dashboard/Database-facing services).
 */
export function stateFor(component: StatusComponent, open: OpenIncident[]): ComponentState {
	const mine = open.filter((i) => i.component === component);
	if (mine.length === 0) return 'operational';
	// Maintenance is never derived from severity; an operator files it explicitly.
	if (mine.some((i) => i.status === 'maintenance')) return 'maintenance';
	let worst: ComponentState = 'operational';
	for (const i of mine) {
		const s = SEVERITY_STATE[i.severity] ?? 'degraded';
		if (COMPONENT_STATES.indexOf(s) > COMPONENT_STATES.indexOf(worst)) worst = s;
	}
	return worst;
}
