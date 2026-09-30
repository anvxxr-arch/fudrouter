/**
 * Ledger display formatting (PRD §48). Pure and client-safe: the credits page,
 * the transactions export and their tests all read money the same way.
 *
 * Money is a bigint of micro-units; every string here is built by string
 * arithmetic on the split whole/fraction parts — never `Number(micro) / 1e6`,
 * which drifts before it formats.
 */

/**
 * Load-data money crosses the server→client seam as a string (devalue has no
 * bigint round-trip guarantee across every adapter), so every money formatter
 * takes the exact integer in either form and coerces by string, never by float.
 */
export type Micro = bigint | string;
const toBig = (m: Micro): bigint => (typeof m === 'bigint' ? m : BigInt(m));

const MICRO = 1_000_000n;

/** Human label for a ledger type, as the PRD §48 history line shows it. */
const TYPE_LABELS: Record<string, string> = {
	credit_purchase: 'credit purchase',
	usage_charge: 'request usage',
	adjustment: 'adjustment',
	refund: 'refund',
	promotion: 'promotion',
	expiration: 'expiration'
};

export function typeLabel(type: string): string {
	return TYPE_LABELS[type] ?? type;
}

/** The currency symbol ($ …) for a 3-letter code, falling back to the code. */
export function currencySymbol(currency: string): string {
	try {
		const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0);
		return parts.find((p) => p.type === 'currency')?.value ?? currency;
	} catch {
		return currency;
	}
}

/**
 * Signed, exactly-precise money: `+$100.00`, `-$0.00421`.
 *
 * Whole cents show two decimals (money convention); sub-cent values keep every
 * significant micro-digit — a usage charge of -$0.00421 must not render as
 * "-$0.00", which is how a ledger starts lying about small requests.
 */
export function formatMicroSigned(micro: Micro, currency = 'USD'): string {
	const m = toBig(micro);
	const sign = m < 0n ? '-' : m > 0n ? '+' : '';
	const abs = m < 0n ? -m : m;
	const whole = abs / MICRO;
	const frac = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
	// Two decimals minimum: "100." must never render, and +$100.00 is what the
	// PRD's own history line shows.
	const fracPart = frac.length >= 2 ? frac : frac.padEnd(2, '0');
	return `${sign}${currencySymbol(currency)}${whole}.${fracPart}`;
}

/** Unsigned variant for balances and invoice totals: `$100.00`, `$0.00421`. */
export function formatMicro(micro: Micro, currency = 'USD'): string {
	return formatMicroSigned(micro, currency).replace(/^[+-]/, '');
}

/**
 * The PRD §48 history line for one ledger row: `+$100.00 credit purchase`,
 * `-$0.00421 request usage`. The credits table renders exactly these two
 * strings side by side; `billing-format.test.ts` pins them to the PRD text.
 */
export function ledgerLine(row: { type: string; amountMicro: Micro; currency: string }): {
	amountLabel: string;
	label: string;
	line: string;
} {
	const amountLabel = formatMicroSigned(row.amountMicro, row.currency);
	const label = typeLabel(row.type);
	return { amountLabel, label, line: `${amountLabel} ${label}` };
}

/**
 * Cursor token for keyset pagination over (created_at desc, id desc):
 * `<created_at key>|<id>`. The time part is the ledger's OWN timestamptz text
 * (microsecond precision), not a JS Date — Date truncates to milliseconds, which
 * would both repeat and skip rows when two postings share a millisecond.
 */
export function encodeCursor(createdAtKey: string, id: string): string {
	return `${createdAtKey}|${id}`;
}

export function decodeCursor(token: string): { createdAtKey: string; id: string } | null {
	const sep = token.trim().indexOf('|');
	if (sep <= 0) return null;
	const createdAtKey = token.trim().slice(0, sep);
	const id = token.trim().slice(sep + 1);
	// The time part is passed back to Postgres as a ::timestamptz parameter, so
	// it must at least look like a timestamp; the id must be a prefixed public id.
	if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/.test(createdAtKey)) {
		return null;
	}
	if (!/^[a-z]{2,6}_[0-9a-z-]+$/.test(id)) return null;
	return { createdAtKey, id };
}

/**
 * Plain decimal dollars for a form value ("10.00", "0.50") — no currency
 * symbol, so an `<input>` round-trips exactly what was saved.
 */
export function microToDecimal(micro: Micro): string {
	const m = toBig(micro);
	const neg = m < 0n;
	const abs = neg ? -m : m;
	const whole = abs / MICRO;
	const frac = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
	return `${neg ? '-' : ''}${whole}.${frac.padEnd(2, '0')}`;
}
