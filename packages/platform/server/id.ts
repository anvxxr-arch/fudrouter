import { uuidv7 } from 'uuidv7';
/**
 * Public entity IDs (PRD §81): `<prefix>_<uuidv7>` — non-sequential, roughly
 * time-ordered, safe to show in URLs and logs. The prefix makes a stray ID
 * self-describing in logs and support tickets (`req_…` is a request).
 *
 * The Go data plane mints the same shape in `backend/go/internal/ids` and
 * backfilled S0 ids are `<prefix>_<legacy>` (spec §1) — prefix strip is always
 * "split on the first `_`".
 */
export const ID_PREFIXES: Record<string, string> = {
	user: 'usr_',
	workspace: 'wrk_',
	workspaceMember: 'mem_',
	workspaceRole: 'rol_',
	project: 'prj_',
	environment: 'env_',
	apiKey: 'key_',
	provider: 'prv_',
	connection: 'con_',
	credential: 'cred_',
	model: 'mdl_',
	providerModel: 'pmdl_',
	modelAlias: 'als_',
	routingPolicy: 'rte_',
	pricingRule: 'prc_',
	request: 'req_',
	requestAttempt: 'rta_',
	billingAccount: 'bac_',
	creditLedger: 'txn_',
	invoice: 'inv_',
	budget: 'bdg_',
	rateLimit: 'lim_',
	alert: 'alr_',
	alertEvent: 'ale_',
	webhook: 'whk_',
	webhookDelivery: 'whd_',
	job: 'job_',
	systemEvent: 'evt_',
	auditLog: 'aud_',
	incident: 'inc_',
	incidentUpdate: 'icu_',
	featureFlag: 'flg_',
	securityRule: 'rul_',
	circuitBreaker: 'cbr_',
	session: 'ses_',
	account: 'acc_',
	verification: 'ver_'
};

export function newId(prefix: string): string {
	// Loud failure over silent garbage: a bad prefix would mint ids the Go side
	// and the migration tooling cannot classify.
	if (!/^[a-z]{2,6}_$/.test(prefix)) {
		throw new Error(`invalid id prefix: ${JSON.stringify(prefix)}`);
	}
	return prefix + uuidv7();
}

/** The prefix of a public id, or null when the id carries none. */
export function idPrefix(id: string): string | null {
	const i = id.indexOf('_');
	return i > 0 ? id.slice(0, i + 1) : null;
}
