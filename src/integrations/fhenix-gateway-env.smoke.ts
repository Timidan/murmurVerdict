import assert from "node:assert/strict";

import {
  FhenixGatewayEnvConfigError,
  loadFhenixGatewayEnvConfig,
} from "./fhenix-gateway-env.js";

const enabledGatewayEnv: NodeJS.ProcessEnv = {
  FHENIX_GATEWAY_ENABLED: "true",
  FHENIX_RPC_URL: "http://fhenix.invalid",
  FHENIX_CHAIN_ID: "84532",
  FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  FHENIX_SEALED_VERDICTS_ADDRESS:
    "0x1111111111111111111111111111111111111111",
};
const gatewayEnvWithoutAddress: NodeJS.ProcessEnv = {
  FHENIX_GATEWAY_ENABLED: "true",
  FHENIX_RPC_URL: "http://fhenix.invalid",
  FHENIX_CHAIN_ID: "84532",
  FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};
const resolvedContractAddress = "0x2222222222222222222222222222222222222222";

assert.equal(loadFhenixGatewayEnvConfig({}), null);
assert.equal(
  loadFhenixGatewayEnvConfig({
    FHENIX_GATEWAY_ENABLED: "FALSE",
    FHENIX_RPC_URL: "http://fhenix.invalid",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    FHENIX_SEALED_VERDICTS_ADDRESS:
      "0x1111111111111111111111111111111111111111",
  }),
  null,
);

assert.throws(
  () => loadFhenixGatewayEnvConfig({ FHENIX_GATEWAY_ENABLED: "yes" }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_GATEWAY_ENABLED",
);

assert.throws(
  () => loadFhenixGatewayEnvConfig({ FHENIX_GATEWAY_ENABLED: "TRUE" }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_RPC_URL",
);

assert.throws(
  () => loadFhenixGatewayEnvConfig({}, { enabled: true }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_RPC_URL",
);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig({
      FHENIX_GATEWAY_ENABLED: "true",
      FHENIX_RPC_URL: "http://fhenix.invalid",
      FHENIX_CHAIN_ID: "not-a-chain",
      FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_CHAIN_ID",
);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig({
      FHENIX_GATEWAY_ENABLED: "true",
      FHENIX_RPC_URL: "http://fhenix.invalid",
      FHENIX_CHAIN_ID: "84532",
      FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: "not-a-key",
      FHENIX_SEALED_VERDICTS_ADDRESS:
        "0x1111111111111111111111111111111111111111",
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
);

const parsed = loadFhenixGatewayEnvConfig({
  ...enabledGatewayEnv,
  FHENIX_GATEWAY_CONFIRMATIONS: "3",
  FHENIX_GATEWAY_RETRY_BASE_MS: "2000",
  FHENIX_GATEWAY_RETRY_MAX_MS: "5000",
  FHENIX_GATEWAY_MAX_ATTEMPTS: "7",
  FHENIX_GATEWAY_STUCK_SEC: "60",
  FHENIX_GATEWAY_BROADCAST_TIMEOUT_MS: "0",
});
assert.equal(parsed?.confirmations, 3);
assert.equal(parsed?.retryBaseMs, 2000);
assert.equal(parsed?.retryMaxMs, 5000);
assert.equal(parsed?.maxAttempts, 7);
assert.equal(parsed?.stuckAfterMs, 60_000);
assert.equal(parsed?.broadcastTimeoutMs, 0);
// Murmur-owned (plaintext-in) sealing defaults OFF: the operator must not be
// able to read pending predictions unless someone explicitly opts in.
assert.equal(
  parsed?.murmurOwnedSealer,
  null,
  "murmur-owned sealing must be off unless explicitly enabled",
);

const parsedWithMurmurOwnedSealing = loadFhenixGatewayEnvConfig({
  ...enabledGatewayEnv,
  MURMUR_OWNED_SEALING_ENABLED: "true",
});
assert.equal(
  typeof parsedWithMurmurOwnedSealing?.murmurOwnedSealer?.sealVerdict,
  "function",
);

const parsedWithoutMurmurOwnedSealing = loadFhenixGatewayEnvConfig({
  ...enabledGatewayEnv,
  MURMUR_OWNED_SEALING_ENABLED: "false",
});
assert.equal(parsedWithoutMurmurOwnedSealing?.murmurOwnedSealer, null);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig({
      ...enabledGatewayEnv,
      MURMUR_OWNED_SEALING_ENABLED: "maybe",
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "MURMUR_OWNED_SEALING_ENABLED",
);

const parsedWithResolvedAddress = loadFhenixGatewayEnvConfig(
  gatewayEnvWithoutAddress,
  {
    contractAddress: resolvedContractAddress,
  },
);
assert.equal(parsedWithResolvedAddress?.contractAddress, resolvedContractAddress);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig({
      ...enabledGatewayEnv,
      FHENIX_SEALED_VERDICTS_ADDRESS:
        "0x3333333333333333333333333333333333333333",
    }, {
      contractAddress: null,
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_SEALED_VERDICTS_ADDRESS",
);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig(gatewayEnvWithoutAddress, {
      contractAddress: "not-an-address",
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_SEALED_VERDICTS_ADDRESS",
);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig({
      ...enabledGatewayEnv,
      FHENIX_GATEWAY_RETRY_BASE_MS: "5000",
      FHENIX_GATEWAY_RETRY_MAX_MS: "4000",
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_GATEWAY_RETRY_MAX_MS",
);

assert.throws(
  () =>
    loadFhenixGatewayEnvConfig({
      ...enabledGatewayEnv,
      FHENIX_GATEWAY_BROADCAST_TIMEOUT_MS: "1",
    }),
  (err) =>
    err instanceof FhenixGatewayEnvConfigError &&
    err.key === "FHENIX_GATEWAY_BROADCAST_TIMEOUT_MS",
);

console.log("fhenix-gateway-env smoke ok");
