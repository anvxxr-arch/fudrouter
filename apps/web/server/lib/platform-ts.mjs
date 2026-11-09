// apps/web/server/lib/platform-ts.mjs — runtime bridge from the plain-JS
// Express server to the TypeScript modules in packages/platform/server/.
//
// Why this exists: the server is untyped .mjs (tsconfig covers src/ only) while
// the canonical security logic (SSRF guard, AES credential envelope, id
// prefixes, validators) lives in packages/platform/*.ts. Node >= 22 strips the
// types natively, so the server imports the canonical modules instead of
// carrying local copies.
//
// The bridge re-exports the shared symbols under the `_`-prefixed names the
// server already uses, so call sites do not change. Where the shared API
// differs in shape (tokenAt/headersFor live in provider-credentials.ts, not
// credentials.ts), the bridge adapts — the adaptation is HERE, in one place,
// not smeared across four server files.
// The imports below go through the package's exports map, not a relative path:
// @fudrouter/platform is a real workspace package, so plain node resolves it the
// same way it resolves any other dependency.
const ssrf = await import('@fudrouter/platform/server/ssrf.ts');
const creds = await import('@fudrouter/platform/server/credentials.ts');
const provCreds = await import('@fudrouter/platform/server/provider-credentials.ts');
const ids = await import('@fudrouter/platform/server/id.ts');
const audit = await import('@fudrouter/platform/server/audit.ts');
const rbac = await import('@fudrouter/platform/rbac');
const publish = await import('@fudrouter/platform/publish');
const publishEnv = await import('@fudrouter/platform/server/publish-env.ts');
const vkmod = await import('@fudrouter/platform/server/vk.ts');
const limits = await import('@fudrouter/platform/server/admin-limits.ts');
const money = await import('@fudrouter/platform/server/money.ts');
const addCredit = await import('@fudrouter/platform/server/add-credit.ts');
const inboundWebhook = await import('@fudrouter/platform/server/webhook-receiver.ts');
const discordBot = await import('@fudrouter/platform/server/discord-bot.ts');
const telegramBot = await import('@fudrouter/platform/server/telegram-bot.ts');
const approval = await import('@fudrouter/platform/server/approval.ts');
const approvalEnv = await import('@fudrouter/platform/server/approval-env.ts');
const claimWriter = await import('@fudrouter/platform/server/claim.ts');

// SSRF: the platform module OWNS the rule, including the literal blocklist --
// isBlockedIp and the range arithmetic are re-exported below for the request
// path (server/lib/ip.mjs) and the tests. An earlier version of this comment
// claimed the shared rule and the console's local copy were equivalent; they
// were not. The shared list was the shorter one and accepted 23 addresses the
// console's refused, NAT64/6to4 spellings of the metadata address among them.
// The console's list is now IN the platform module, so there is one rule and
// nothing to keep in sync.
import net from 'node:net';
export function _isBlockedLiteral(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  // DNS-name bar (shared isBlockedLiteral is IP-only by design; names resolve
  // in assertPublicUpstream). localhost / intranet TLDs never reach DNS.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  const bare = h.includes('%') ? h.slice(0, h.indexOf('%')) : h;
  if (net.isIP(bare)) return ssrf.isBlockedLiteral(bare);
  return false;
}
// The literal blocklist itself, re-exported so the request path and the tests
// reach exactly the implementation the guard uses.
export const isBlockedIp = ssrf.isBlockedIp;
export const _parseV6 = ssrf.parseV6;
export const _ipv4ToBig = ssrf.ipv4ToBig;
export const _ipv4BlockedBig = ssrf.ipv4BlockedBig;
export const _ipv6BlockedBig = ssrf.ipv6BlockedBig;

export async function _assertPublic(rawUrl, allowPrivate = false) {
	const r = await ssrf.assertPublicUpstream(rawUrl, allowPrivate);
	return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/** Pinned upstream fetch (SSRF DNS-rebind safe) + plain fetch under `guardedFetch`. */
export const guardedUpstreamFetch = ssrf.guardedUpstreamFetch;
export const guardedFetch = ssrf.guardedFetch;

// Input bounds: admin-limits.ts OWNS them (a price of 1e308 reaching a
// bigint micro-price column, an unbounded batch turning one POST into
// thousands of inserts). Re-exported so admin.mjs bounds the provider-enable
// path with the same constant instead of a local copy that can drift.
export const MAX_PRICE_USD = limits.MAX_PRICE_USD;

// Money arithmetic + manual add-credit rule (ceiling + key namespace). Shared
// with packages/platform so the two manual top-up surfaces and the scrub report
// agree on one threshold; the .mjs writers import these rather than copying.
export const parseAmountToMicro = money.parseAmountToMicro;
export const MAX_ADD_CREDIT_MICRO = addCredit.MAX_ADD_CREDIT_MICRO;
export const ADD_CREDIT_KEY_PREFIX = addCredit.ADD_CREDIT_KEY_PREFIX;
export const addCreditKey = addCredit.addCreditKey;
export const validateAddCreditAmount = addCredit.validateAddCreditAmount;
export const addCreditError = addCredit.addCreditError;
export const addCreditKeyError = addCredit.addCreditKeyError;
export const validateAddCreditKey = addCredit.validateAddCreditKey;

// Credentials: byte-identical AES-256-GCM envelope (iv[12]||ct||tag[16]).
export const _encCred = (plain) => creds.encryptCredentials(plain);
export const _decCred = (enc) => creds.decryptCredentials(enc);
// Token/header helpers live in provider-credentials.ts (flat + pooled forms).
export const _tokenAt = (cred, i) => provCreds.tokenAt(cred, i);
export function _headersFor(cred, token) {
	const h = { ...((cred.default_headers ?? {})) };
	if (token) h.authorization = `Bearer ${token}`;
	return h;
}

// Valkey: the shared ioredis client (packages/platform/server/vk.ts). It owns
// VALKEY_URL, lazy connect and the degrade-open policy; vk() returns null when
// Valkey is not deployed, which is the "disabled" branch the call sites want.
// The console adds only the per-call deadline the client deliberately does not
// set (a shared commandTimeout would change the workers' and scheduler's too).
export const _vk = () => vkmod.vk();

// RBAC: the role -> capability table is the platform's (@fudrouter/platform/rbac),
// the same object the SPA's route guards import. Re-exported under the plain names
// server/lib/rbac.mjs has always exported, so admin.mjs, index.mjs and
// src/lib/caps.ts all read one table -- a UI that gates on a table the API does
// not enforce shows controls that 403.
export const ROLE_CAPS = rbac.ROLE_CAPS;
export const capsFor = rbac.capsFor;

// IDs: single canonical prefix table.
export const ID_PREFIXES = ids.ID_PREFIXES;
export const newId = (prefix) => ids.newId(prefix);

// The publish gate: packages/platform/publish.ts OWNS the rule (model active
// AND provider servable), and it is the same predicate the Go router's SQL
// mirrors. The console used to carry TWO hand copies of it — admin.mjs's `_reach`
// and public.mjs's `served` — which is exactly the drift the module's header
// warns about. Both now call this.
//
// `reachability` is the reason-carrying form (the admin surfaces show WHY a row
// is hidden); `served` is the boolean the catalogue filters on.
export const reachability = (modelStatus, providerStatus, allowDevProviders) =>
	publish.reachability(modelStatus, providerStatus, allowDevProviders);
export const served = (modelStatus, providerStatus, allowDevProviders) =>
	publish.reachability(modelStatus, providerStatus, allowDevProviders).served;
// The env read for the opt-in, from the same module that owns the rule.
export const allowDevProviders = () => publishEnv.allowDevProviders();

// Inbound gateway callback receiver (B3a): the pure verify/claim/guard DECISIONS
// live in packages/platform/server/webhook-receiver.ts; the Express route
// (server/webhook.mjs) re-uses them through here. The signature header name is
// the one canonical constant, so a route and its test cannot drift.
export const INBOUND_SIGNATURE_HEADER = inboundWebhook.INBOUND_SIGNATURE_HEADER;
export const verifyInbound = inboundWebhook.verifyInbound;
export const claimDelivery = inboundWebhook.claimDelivery;
export const assertInboundPublic = inboundWebhook.assertInboundPublic;
export const httpStatusForReject = inboundWebhook.httpStatusForReject;

// Approver fallback/eskalasi (B5): the pure DECISIONS live in approval.ts and
// the env reads in approval-env.ts. The transports re-use these through the
// bridge instead of carrying .mjs copies — one escalation rule for Telegram and
// Discord. `escalate` is the state transition a transport's TTL tick calls.
// Durable claim writer (CS1): the ONE pending -> claimed write both bot
// transports and the web checkout share. `drizzleClaimWriter(db)` returns
// `{ record(paymentId, proofUrl), resolve(paymentId) }` - the two seams the
// bot adapters already declare (`recordClaim`/`resolveClaim` map 1:1).
export const drizzleClaimWriter = claimWriter.drizzleClaimWriter;
export const drizzleApprovalAnswerWriter = claimWriter.drizzleApprovalAnswerWriter;

export const parseApprovers = approval.parseApprovers;
export const parseApprovalTtlMs = approval.parseApprovalTtlMs;
export const approvalRoute = approval.approvalRoute;
export const nextApprover = approval.nextApprover;
export const escalate = approval.escalate;
export const DEFAULT_APPROVAL_TTL_MS = approval.DEFAULT_APPROVAL_TTL_MS;
export const APPROVERS_ENV = approvalEnv.APPROVERS_ENV;
export const APPROVAL_TTL_ENV = approvalEnv.APPROVAL_TTL_ENV;
export const approvalApprovers = () => approvalEnv.approvers();
export const approvalTtlMs = () => approvalEnv.approvalTtlMs();
export const approvalConfig = () => approvalEnv.approvalConfig();
export const telegramApproverUsers = () => approvalEnv.telegramApproverUsers();
export const discordApproverUsers = () => approvalEnv.discordApproverUsers();

// Telegram bot adapter (C1): the thin-I/O handlers and pure renderers live in
// packages/platform/server/telegram-bot.ts. The bridge re-exports them so a
// future Telegram webhook route reuses the same renderers + handlers instead of
// carrying .mjs copies — the same split as the inbound-webhook block above.
export const plansText = telegramBot.plansText;
export const unknownPlanText = telegramBot.unknownPlanText;
export const grantedText = telegramBot.grantedText;
export const paymentErrorText = telegramBot.paymentErrorText;
export const handleMessage = telegramBot.handleMessage;
export const handleCallbackQuery = telegramBot.handleCallbackQuery;
export const deliverWarning = telegramBot.deliverWarning;
export const telegramApprovalMessage = telegramBot.approvalMessage;
export const encodeApprovalCallbackData = telegramBot.encodeApprovalCallbackData;
export const assertCallbackDataFits = telegramBot.assertCallbackDataFits;

// Discord payment bot adapter (C2): pure renderers + routers live in
// packages/platform/server/discord-bot.ts; the transport wires them to real
// DiscordReply/DiscordSend/slash-command dispatch. One rendering source (bots.ts).
export const discordRenderPlans = discordBot.renderPlans;
export const discordRenderPay = discordBot.renderPay;
export const discordRenderApproval = discordBot.renderApproval;
export const discordParseApprovalCustomId = discordBot.parseApprovalCustomId;
export const discordApprovalCustomId = discordBot.approvalCustomId;
export const discordHandlePlans = discordBot.handlePlans;
export const discordHandlePay = discordBot.handlePay;
export const discordHandleProof = discordBot.handleProof;
export const discordHandleApproval = discordBot.handleApproval;

// Job queue: enqueue() validates the type against JOB_TYPES (a typo'd type
// string would become a forever-pending row no handler claims — the exact bug
// jobs.ts was written to prevent) and carries the Valkey wake hint a hand-rolled
// `insert into job` would not. Lazy, because jobs.ts statically imports
// db/index.ts, which throws at import time when DATABASE_URL is unset — and
// this module's unit tests import it with no database at all.
let _jobsmod = null;
export async function _enqueueJob(type, payload, options, handle) {
	if (!_jobsmod) _jobsmod = await import('@fudrouter/platform/server/jobs.ts');
	return _jobsmod.enqueue(type, payload, options ?? {}, handle);
}

// Audit redaction: shared redactSecrets covers the same key vocabulary
// (secret|token|password|key_hash|credentials? + exact api_key/authorization).
export const _sanitizeAudit = (v) => audit.redactSecrets(v);
export function _dropRedacted(v) {
	if (Array.isArray(v)) return v.map(_dropRedacted);
	if (v && typeof v === 'object') {
		const out = {};
		for (const [k, x] of Object.entries(v)) {
			if (x === '[redacted]') continue;
			out[k] = _dropRedacted(x);
		}
		return out;
	}
	return v;
}
void net;