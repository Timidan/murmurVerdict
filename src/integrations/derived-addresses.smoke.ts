import { strict as assert } from "node:assert";

import { deriveAddressFromKey } from "./derived-addresses.js";

// An address env var beside the private key it belongs to is pure duplication:
// the key already determines the address. So derive it — and when the operator
// ALSO states one, refuse on disagreement rather than silently preferring
// either. Picking one would mean signing with, or authorizing, an identity the
// operator did not intend.
process.stdout.write("murmur derived addresses smoke\n");

// Well-known test vector: hardhat account #0.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// ── unset: derived, nothing to get wrong ────────────────────────────────────
assert.equal(
  deriveAddressFromKey({
    privateKey: KEY,
    configuredName: "RELAYER_ADDRESS",
    keyName: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
  }),
  ADDRESS,
);

// ── set and agreeing: accepted, including a non-checksummed spelling ────────
for (const spelling of [ADDRESS, ADDRESS.toLowerCase(), `  ${ADDRESS}  `]) {
  assert.equal(
    deriveAddressFromKey({
      privateKey: KEY,
      configured: spelling,
      configuredName: "RELAYER_ADDRESS",
      keyName: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
    }),
    ADDRESS,
    `"${spelling}" is the same address and must be accepted`,
  );
}

// ── set and DISAGREEING: refuse, naming both sides ──────────────────────────
assert.throws(
  () =>
    deriveAddressFromKey({
      privateKey: KEY,
      configured: "0x000000000000000000000000000000000000dEaD",
      configuredName: "GRANTOR_ADDRESS",
      keyName: "FHENIX_GRANT_PRIVATE_KEY",
    }),
  (err: unknown) =>
    err instanceof Error &&
    /GRANTOR_ADDRESS is 0x0000/.test(err.message) &&
    /FHENIX_GRANT_PRIVATE_KEY controls 0xf39F/.test(err.message) &&
    /Refusing to guess/.test(err.message),
  "a conflict must name both the stated and the derived address",
);

// ── set but malformed: refuse, and say it is optional ───────────────────────
assert.throws(
  () =>
    deriveAddressFromKey({
      privateKey: KEY,
      configured: "not-an-address",
      configuredName: "RELAYER_ADDRESS",
      keyName: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
    }),
  /is not a valid address.*It is optional/s,
);

process.stdout.write("OK derived addresses smoke\n");
