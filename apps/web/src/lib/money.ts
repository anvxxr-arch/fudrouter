// Money is stored as integer micro-dollars (1 USD = 1_000_000). Two surfaces
// format it -- the member dashboard and the admin console -- and they had drifted
// apart: the console printed "$102055.00" (no grouping, cents truncated) while
// the dashboard printed "$102,054.94". Same ledger, two answers. One function.

const GROUP = new Intl.NumberFormat("en-US");

// Micro-dollars are integers, so the whole part must never pass through
// Number(): 2^53 micro is only $9,007,199 and a balance can legitimately be
// larger. Split with BigInt, then group the digits.
export function fmtMicro(v: string | number | null | undefined) {
  if (v === null || v === undefined) return "—";
  try {
    const micro = BigInt(v);
    const sign = micro < 0n ? "-" : "";
    const abs = micro < 0n ? -micro : micro;
    // Round half-up at the cent, not truncate: 100504937518 micro is
    // $100,504.937518 and reads as .94 everywhere else in the product.
    const cents = (abs + 5_000n) / 10_000n;
    const whole = cents / 100n;
    const frac = (cents % 100n).toString().padStart(2, "0");
    return `${sign}$${GROUP.format(whole)}.${frac}`;
  } catch {
    return String(v);
  }
}

/** Compact form for axis ticks: $102.1k, $9.4M. Keeps chart labels short. */
export function fmtMicroShort(v: string | number | null | undefined) {
  try {
    const micro = BigInt(v ?? "0");
    const sign = micro < 0n ? "-" : "";
    const abs = micro < 0n ? -micro : micro;
    const usd = Number(abs) / 1_000_000;
    if (usd >= 1_000_000) return `${sign}$${(usd / 1_000_000).toFixed(1)}M`;
    if (usd >= 1_000) return `${sign}$${(usd / 1_000).toFixed(1)}k`;
    return `${sign}$${usd.toFixed(2)}`;
  } catch {
    return String(v ?? "—");
  }
}
