// Package ids mints the platform's public-safe entity IDs.
//
// Format (docs/specs/2026-09-30-platform-schema.md §1): `<prefix>_<uuidv7>` —
// roughly time-ordered, non-sequential, safe to show in URLs and logs. App-side
// generated, never `serial`, and byte-compatible with the TS control plane
// (`packages/platform/server/id.ts` `newId`), which formats the same way from the
// `uuidv7` package.
//
// Prefix strip is "split on the first `_`" (spec §1), which is what makes
// backfilled ids like `prv_mingles` parseable alongside minted ones.
package ids

import (
	"strings"

	"github.com/gofrs/uuid/v5"
)

// Known ID prefixes (spec §1). Not every entity is minted by the data plane, but
// the table is the one place both planes can check a prefix against.
var ID_PREFIXES = map[string]string{
	"usr":  "user",
	"wrk":  "workspace",
	"mem":  "workspace_member",
	"rol":  "workspace_role",
	"prj":  "project",
	"env":  "environment",
	"key":  "api_key",
	"prv":  "provider",
	"con":  "connection",
	"cred": "credential",
	"bdg":  "budget",
	"lim":  "rate_limit",
	"alr":  "alert",
	"ale":  "alert_event",
	"aud":  "audit_log",
	"icu":  "incident_update",
	"flg":  "feature_flag",
	"rul":  "security_rule",
	"cbr":  "circuit_breaker",
	"mdl":  "model",
	"pmdl": "provider_model",
	"als":  "model_alias",
	"rte":  "routing_policy",
	"prc":  "pricing_rule",
	"req":  "request_log",
	"rta":  "request_attempt",
	"bac":  "billing_account",
	"txn":  "credit_ledger",
	"inv":  "invoice",
	"whk":  "webhook",
	"whd":  "webhook_delivery",
	"job":  "job",
	"evt":  "system_event",
	"inc":  "incident",
}

// New mints `prefix_<uuidv7-lowercase>`. The prefix is used verbatim (it is
// always a short literal like `req`), so the caller owns its spelling.
func New(prefix string) string {
	return prefix + "_" + uuid.Must(uuid.NewV7()).String()
}

// Prefix returns the entity prefix of a public id — everything before the first
// underscore (spec §1: "Prefix strip = split on the first `_`"), so backfilled
// ids like `usr_u_apkpg2yCQHFi` yield `usr`.
func Prefix(id string) string {
	p, _, _ := strings.Cut(id, "_")
	return p
}
