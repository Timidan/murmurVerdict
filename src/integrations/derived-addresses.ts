import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Addresses derived from the key that controls them.
 *
 * An address env var sitting beside the private key it belongs to is pure
 * duplication: the key already determines the address, so the var can only
 * agree with it or be wrong. And "wrong" is not theoretical — DEPLOYMENT.md
 * shipped `GRANTOR_ADDRESS="$GRANT_ADDRESS"`, a variable that exists nowhere,
 * so copying the documented deploy sequence exported an empty grantor.
 *
 * The rule here is DERIVE, then REFUSE ON DISAGREEMENT:
 *
 *   - var unset  → compute it from the key. Nothing to get wrong.
 *   - var set and matching → fine, the operator is being explicit.
 *   - var set and DIFFERENT → throw. Never silently prefer one over the
 *     other: a mismatch means the operator believes a different key is in
 *     play, and picking either interpretation risks signing with the wrong
 *     identity or authorizing the wrong address on-chain.
 *
 * Deliberately NOT applied to addresses that are a business choice rather
 * than a key's identity — a payout sink or a payment seller must be stated,
 * because deriving those from whatever key happens to be in scope is how
 * money quietly goes somewhere nobody chose.
 */
export function deriveAddressFromKey(input: {
  /** 0x-prefixed 32-byte private key. */
  privateKey: string;
  /** Value the operator set, if any. */
  configured?: string | undefined;
  /** Env var name, for the error message. */
  configuredName: string;
  /** Env var name holding the key, for the error message. */
  keyName: string;
}): `0x${string}` {
  const derived = getAddress(
    privateKeyToAccount(input.privateKey as `0x${string}`).address,
  );
  const configured = input.configured?.trim();
  if (!configured) return derived;

  let normalized: string;
  try {
    normalized = getAddress(configured);
  } catch {
    throw new Error(
      `${input.configuredName} is not a valid address (got "${configured}"). ` +
        `It is optional — leave it unset and it is derived from ${input.keyName}.`,
    );
  }
  if (normalized !== derived) {
    throw new Error(
      `${input.configuredName} is ${normalized} but ${input.keyName} controls ` +
        `${derived}. Refusing to guess which one you meant: either drop ` +
        `${input.configuredName} (it is derived from the key) or fix the key.`,
    );
  }
  return derived;
}
