export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isoFromUnixSeconds(s: bigint | number): string {
  const ms = typeof s === "bigint" ? Number(s) * 1000 : s * 1000;
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

export function nowIso(now: () => Date): string {
  return now().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Formats a uint scaled by 10^decimals into a plain decimal string with no
 * trailing zeros beyond what's needed.
 */
export function formatFixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  const intPart = s.slice(0, cut);
  const fracPart = s.slice(cut).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

/**
 * Pyth gives `price` as a signed integer string and `expo` as a (typically
 * negative) base-10 exponent. e.g. price="312485000000", expo=-8 → "3124.85".
 */
export function formatPythDecimal(value: bigint, expo: number): string {
  if (expo === 0) return value.toString();
  if (expo > 0) return `${value.toString()}${"0".repeat(expo)}`;
  return formatFixed(value, -expo);
}
