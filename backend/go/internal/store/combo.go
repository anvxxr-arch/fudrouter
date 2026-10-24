// combo.go — resolving a combo name into the ordered model list.
//
// A combo (`premium` = [opus, gpt-6, glm-5]) is the one 9Router feature that
// decides adoption, and the reason it is cheap here is that this router already
// walks candidate models in order: routing.Select orders them and routing.Execute
// tries each until one answers, recording a request_attempt per hop.
//
// So a combo adds NO routing code. It adds one resolution branch that maps a name
// onto an ordered set of model ids, and the existing walker does the rest —
// meaning every combo hop is metered, logged, budget-gated and auditable for
// free, which is the part a gateway without a ledger cannot offer.
//
// Precedence: an account combo beats an alias and beats a literal slug, because a
// customer who names a combo expects THEIR combo. The resolution itself lives in
// ResolveModel's UNION ALL statement (catalog.go) as branch -1 — a separate
// probe here cost every canonical-slug request one extra round trip, the exact
// regression admission_count_test.go pins. A combo whose every member is
// inactive produces no rows and falls through to the alias/slug branches, so a
// stale combo never kills a customer's literal model name.
package store
