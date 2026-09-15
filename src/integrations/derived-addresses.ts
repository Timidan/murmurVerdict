import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Address derived from the key that controls it. Unset → derived; set and matching → ok;
 * set and different → throw, never pick one. Not for business-choice addresses
 * (payout sink, seller); those must be stated explicitly.
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
