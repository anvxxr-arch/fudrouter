package proxy

// The owner's rule-12 entitlement gate, wired into admission (B0 / inv#2).
//
// Why this sits in its own file: the subscription decision is an entitlement
// question (a time-window the member already paid for) applied at an admission
// point (checkBudgets) that used to be purely a balance/ledger gate. A live
// subscription and a prepaid balance are NOT the same state — the schema
// (0025) split them precisely because "expired" and "broke" are different.
// The wiring lives here and checkBudgets folds its one boolean into the old
// balance decision; the precedence — live wins, a lapsed window refuses, never
// subscribed falls through — is therefore one place, not an `if` buried in a
// 600-line file.
//
// The gate only runs while the payment-gateway flip turns the balance gate on
// (store.FreeAccessNoPaymentGateway = false): before the flip it is dead work
// (the balance gate is already skipped), and refusing a lapsed window before
// the flip would ADD a refusal the dormant-balance frpayg path does not have.
// The DECISION is the entitlement package's pure CheckSubscription; the adapter
// below only turns a store row into an *entitlement.Subscription, which is
// core, not transport.

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/anvxxr-arch/fudrouter/backend/go/internal/entitlement"
)

// entGuard is the process-wide Guard for the rule-12 gate. Admission needs none
// of the per-key IP/concurrency state the Guard also holds (that lives on the
// API-key path), so one instance is shared and CheckSubscription only reads the
// Guard's clock — no map allocation on the hot path.
var entGuard = entitlement.New()

// subStatusActive is the status value a live window must carry. It is spelled
// out here so the gate and the 0025 CHECK vocabulary cannot drift, and so a
// cancelled/refunded row with a still-future expires_at is NOT read as live
// (entitlement.Subscription.Live alone would, because it only looks at time).
const subStatusActive = "active"

// errEntitlementExpired is the "a subscription existed but is not live" refusal
// (owner rule 12). It is a distinct sentinel so a test can tell a lapsed window
// apart from store.ErrInsufficientCredits, even though both surface to the
// client as 402 (begin maps any checkBudgets error to 402).
var errEntitlementExpired = errors.New("subscription expired")

// checkSubscription runs the rule-12 entitlement gate for one account. Its
// caller (checkBudgets) runs it ONLY while the balance gate is live; this
// method classifies the account's subscription and returns (live, err):
//
//	(true,  nil) — a live subscription: skip the balance hard stop (inv#2).
//	(false, errEntitlementExpired) — a lapsed/cancelled window: refuse with the
//	                                "expired" rule, distinct from a hard stop.
//	(false, nil) — never subscribed (RuleNoSubscription): no opinion — the
//	               balance gate decides (inv#2 "live OR balance > threshold").
//
// A subscription read that cannot be trusted fails CLOSED: an unreadable
// entitlement must not admit spend the window may or may not cover.
func (h *Handler) checkSubscription(ctx context.Context, lc *lifecycle) (bool, error) {
	if lc.key == nil || h.store == nil {
		return false, nil
	}
	sub, err := h.store.AdmissionSubscription(ctx, lc.key.UserID)
	if err != nil {
		log.Printf("[proxy] subscription lookup failed for %s: %v", lc.key.UserID, err)
		return false, err
	}

	// Store row -> entitlement value. The distinction the owner's rule 12 needs
	// is carried by the VALUE's presence and expiry:
	//   - a live window        -> non-nil, future ExpiresAt -> Allow
	//   - a lapsed/cancelled   -> non-nil, ZERO ExpiresAt  -> RuleExpired
	//   - never subscribed     -> nil                       -> RuleNoSubscription
	// A zero ExpiresAt (not a past one) is deliberately used for the lapsed
	// case because the row's real expires_at can be in the FUTURE for a
	// cancelled/refunded window, and that must still read as "expired", never
	// "live" (entitlement.Live is time-only).
	var ent *entitlement.Subscription
	if sub != nil {
		if sub.Status == subStatusActive && sub.ExpiresAt.After(time.Now()) {
			ent = &entitlement.Subscription{Plan: sub.Plan, ExpiresAt: sub.ExpiresAt}
		} else {
			ent = &entitlement.Subscription{Plan: sub.Plan}
		}
	}

	d := entGuard.CheckSubscription(ent)
	switch {
	case d.Allow:
		return true, nil
	case d.Rule == entitlement.RuleExpired:
		return false, errEntitlementExpired
	default: // RuleNoSubscription
		return false, nil
	}
}
