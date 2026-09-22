// Role checks live in `$lib/server/roles.ts` (capability model). This module
// keeps only the value-formatting helpers shared by the admin pages.

/** Parse a textarea of `Header: value` lines into a header map. */
export function parseHeaderLines(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

/** USD string -> micro-units integer string. Money is never a float. */
export function usdToMicro(usd: string): string | null {
	if (!usd.trim()) return null;
	const n = Number(usd);
	if (!Number.isFinite(n) || n < 0) return null;
	return BigInt(Math.round(n * 1_000_000)).toString();
}

export function microToUsd(micro: string | number | bigint | null | undefined): string {
	if (micro === null || micro === undefined) return '—';
	return (Number(micro) / 1_000_000).toFixed(2);
}
