// ─── Atomic amounts → something a person can read ───────────────────────────
//
// Every money value on the wire is a string of ATOMIC UNITS, and it is a
// string because these routinely exceed what a JS number can hold exactly.
// Nothing in this file converts to `number`; the whole path stays BigInt and
// the decimal point is inserted by string surgery.
//
// The sign is carried through deliberately. A negative balance means murmur
// paid out more than accrued, and the account UI states that rather than
// clamping it to zero.

/** Decimals per settlement asset. USDC and EURC are both 6. */
const DECIMALS: Record<string, number> = {
  USDC: 6,
  EURC: 6,
  USDT: 6,
  DAI: 18,
  ETH: 18,
};

/** Decimals for a known settlement asset, or null when the code is unknown. */
export function decimalsFor(currency: string | null | undefined): number | null {
  if (!currency) return null;
  return DECIMALS[currency.toUpperCase()] ?? null;
}

/**
 * "1234500" + USDC → "1.2345". Signed, never rounded away.
 *
 * Trailing zeros are trimmed because a column of "0.050000" reads as noise,
 * but a value that is genuinely zero renders "0" rather than an empty string.
 */
export function formatAtoms(
  atoms: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (atoms === null || atoms === undefined || atoms === "") return "—";
  let value: bigint;
  try {
    value = BigInt(atoms);
  } catch {
    return "—";
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const decimals = decimalsFor(currency);
  // An unknown code has no known scale, so the raw count is the only honest
  // value; the unit says these are atoms and not whole units.
  if (decimals === null) return `${negative ? "-" : ""}${magnitude} atoms`;
  const scale = 10n ** BigInt(decimals);
  const whole = (magnitude / scale).toString();
  const frac = (magnitude % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole;
  return negative ? `-${body}` : body;
}

/** "1234500" + USDC → "1.2345 USDC". The unit belongs beside the number. */
export function formatAtomsWithCurrency(
  atoms: string | null | undefined,
  currency: string | null | undefined,
): string {
  const body = formatAtoms(atoms, currency);
  if (body === "—" || !currency) return body;
  return `${body} ${currency.toUpperCase()}`;
}

/** True when the string parses as a value above zero. Safe on junk. */
export function isPositiveAtoms(atoms: string | null | undefined): boolean {
  if (!atoms) return false;
  try {
    return BigInt(atoms) > 0n;
  } catch {
    return false;
  }
}
