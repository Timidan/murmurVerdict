import assert from "node:assert/strict";

import {
  makeControllerWalletBindingAuthorization,
  makeControllerWalletReattestationAuthorization,
  makeRuntimeKeyAuthorization,
} from "./controller-wallet-authorization.js";
import { VerdictError } from "./schema.js";

const now = () => new Date("2026-01-02T03:04:05.678Z");
const wallet = "0x1111111111111111111111111111111111111111";

const binding = makeControllerWalletBindingAuthorization({
  agentSlug: "maya",
  walletAddress: wallet,
  chainId: "8453",
  walletKind: "embedded",
  provider: "privy",
  now,
});
assert.equal(binding.wallet_address, wallet);
assert.equal(binding.chain_id, "8453");
assert.equal(binding.wallet_kind, "embedded");
assert.equal(binding.provider, "privy");
assert.equal(binding.authorization_issued_at, "2026-01-02T03:04:05Z");
assert.equal(
  binding.message,
  [
    "Murmur Controller Wallet Binding",
    "agent:maya",
    `wallet:${wallet}`,
    "chain:8453",
    "wallet_kind:embedded",
    "provider:privy",
    "scope:identity-only",
    "issued_at:2026-01-02T03:04:05Z",
  ].join("\n"),
);

const reattestation = makeControllerWalletReattestationAuthorization({
  agentSlug: "maya",
  controllerWalletAddress: wallet,
  controllerChainId: "8453",
  attestationNonce: "nonce_1234567890abcd",
  issuedAt: "2026-01-02T03:04:06Z",
  newAuthorizationNonce: () => {
    throw new Error("explicit attestation nonce should not read adapter");
  },
  now: () => {
    throw new Error("explicit issuedAt should not read clock");
  },
});
assert.equal(reattestation.attestation_nonce, "nonce_1234567890abcd");
assert.equal(reattestation.authorization_issued_at, "2026-01-02T03:04:06Z");
assert.match(reattestation.message, /Murmur Controller Wallet Re-Attestation/);

const generatedReattestation = makeControllerWalletReattestationAuthorization({
  agentSlug: "maya",
  controllerWalletAddress: wallet,
  controllerChainId: "8453",
  newAuthorizationNonce: () => "reattest_generated_nonce_1",
  now,
});
assert.equal(generatedReattestation.attestation_nonce, "reattest_generated_nonce_1");
assert.match(
  generatedReattestation.message,
  /attestation_nonce:reattest_generated_nonce_1/,
);

const runtimeKey = makeRuntimeKeyAuthorization({
  agentSlug: "maya",
  controllerWalletAddress: wallet,
  controllerChainId: "8453",
  policy: { allowed_market_ids: ["eth.1h"], feed_packets: true },
  authorizationNonce: "runtime_nonce_123456",
  newAuthorizationNonce: () => {
    throw new Error("explicit runtime nonce should not read adapter");
  },
  expiresAt: "2026-01-03T03:04:05Z",
  issuedAt: "2026-01-02T03:04:06Z",
  now,
});
assert.equal(
  runtimeKey.policy_json,
  '{"allowed_market_ids":["eth.1h"],"feed_packets":true}',
);
assert.match(runtimeKey.policy_hash, /^0x[0-9a-f]{64}$/);
assert.equal(runtimeKey.authorization_nonce, "runtime_nonce_123456");
assert.equal(runtimeKey.expires_at, "2026-01-03T03:04:05Z");
assert.match(runtimeKey.message, /scope:gateway-runtime-key/);

const generatedRuntimeKey = makeRuntimeKeyAuthorization({
  agentSlug: "maya",
  controllerWalletAddress: wallet,
  controllerChainId: "8453",
  policy: {},
  newAuthorizationNonce: () => "runtime_generated_nonce_1",
  now,
});
assert.equal(generatedRuntimeKey.authorization_nonce, "runtime_generated_nonce_1");
assert.equal(generatedRuntimeKey.expires_at, null);

assert.throws(
  () =>
    makeRuntimeKeyAuthorization({
      agentSlug: "maya",
      controllerWalletAddress: wallet,
      controllerChainId: "8453",
      policy: {},
      expiresAt: "2026-01-01T03:04:05Z",
      now,
    }),
  (err) => err instanceof VerdictError && err.httpStatus === 400,
);

console.log("controller-wallet-authorization smoke ok");
