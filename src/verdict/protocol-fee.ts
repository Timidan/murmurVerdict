// ─── The protocol fee — murmur's cut of an early-access sale ────────────────
//
// Murmur keeps `MURMUR_PROTOCOL_FEE_BPS` of every paid decrypt-grant; the rest accrues to the agent owner.
// Standalone from grant config: calls are sealed (and fee-snapshotted) even while paid grants are off.
// No default anywhere; a fee is a business decision.

export const PROTOCOL_FEE_BPS_ENV = "MURMUR_PROTOCOL_FEE_BPS";

/** Basis-point denominator. 10000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000n;

export class ProtocolFeeConfigError extends Error {
  readonly key = PROTOCOL_FEE_BPS_ENV;

  constructor(message: string) {
    super(`${PROTOCOL_FEE_BPS_ENV}: ${message}`);
    this.name = "ProtocolFeeConfigError";
  }
}

/** Null when unset or blank (distinct from 0%). Throws on anything but an integer 0..10000. */
export function parseProtocolFeeBps(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[PROTOCOL_FEE_BPS_ENV]?.trim() ?? "";
  if (!raw) return null;
  // Digits only before Number(): "1e3", "0x64" and "1000.0" all survive Number().
  if (!/^[0-9]+$/.test(raw)) {
    throw new ProtocolFeeConfigError(
      `must be a whole number of basis points, 0..10000 (got "${raw}")`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ProtocolFeeConfigError(
      `must be between 0 and 10000 basis points (got "${raw}")`,
    );
  }
  return value;
}

/**
 * The fee, or a loud failure. Used wherever a split is about to be written
 * down: a snapshot with no fee is a sale whose terms nobody can reconstruct.
 */
export function requireProtocolFeeBps(
  env: NodeJS.ProcessEnv = process.env,
  because = "an early-access sale cannot be split without it",
): number {
  const parsed = parseProtocolFeeBps(env);
  if (parsed === null) {
    throw new ProtocolFeeConfigError(
      `is required — ${because}. Set it to murmur's cut in basis points ` +
        `(1000 = 10% murmur / 90% provider, 300 = 3% / 97%). There is no ` +
        `default: a fee is a business decision, not a fallback.`,
    );
  }
  return parsed;
}

export interface FeeSplit {
  /** What the subscriber paid, in the settlement asset's atomic units. */
  gross: bigint;
  /** Murmur's cut, floored. */
  fee: bigint;
  /** What accrues to the provider. Always exactly gross - fee. */
  net: bigint;
}

/**
 * Split a gross amount at `feeBps`, in BigInt. The fee floors and the provider takes the
 * remainder, so fee + net always equals gross.
 */
export function splitFeeAtoms(grossAtoms: string, feeBps: number): FeeSplit {
  if (!/^[0-9]+$/.test(grossAtoms)) {
    throw new Error(
      `gross amount must be a non-negative integer atomic amount (got "${grossAtoms}")`,
    );
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error(`fee bps must be an integer 0..10000 (got ${feeBps})`);
  }
  const gross = BigInt(grossAtoms);
  const fee = (gross * BigInt(feeBps)) / BPS_DENOMINATOR;
  const net = gross - fee;
  // Cheap, and it is the one invariant the whole ledger rests on.
  if (fee + net !== gross) {
    throw new Error(
      `fee split does not conserve value: ${fee} + ${net} !== ${gross}`,
    );
  }
  return { gross, fee, net };
}
