// subscription-checkout.ts — the checkout response shapes the subscription page
// must render.
//
// The checkout endpoint has two response shapes, and the branch that separates
// them is what this module owns:
//
//   - Mayar (MAYAR_API_KEY set):   { gatewayRef, checkoutUrl, qris: null, gateway: 'mayar', ... }
//   - legacy static QRIS (no key): { gatewayRef, qris, ... }   (no checkoutUrl, no gateway)
//
// `checkoutUrl` is authoritative: a Mayar response always carries a non-null
// URL and a null QRIS; the legacy response never carries a URL. `qris` is the
// fallback — a still-empty string is treated as absent so the page renders
// neither panel rather than a copy button with nothing to copy.

export type CheckoutKind = 'mayar' | 'qris';

export interface CheckoutPayload {
	checkoutUrl?: string | null;
	qris?: string | null;
	gateway?: string;
}

/** Which checkout artefact a response carries, or null when it carries neither. */
export function checkoutKind(checkout: CheckoutPayload | null | undefined): CheckoutKind | null {
	if (!checkout) return null;
	if (checkout.checkoutUrl) return 'mayar';
	if (checkout.qris) return 'qris';
	return null;
}