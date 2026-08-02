import { strict as assert } from "node:assert";

import {
  FhenixGrantConfigError,
  loadFhenixGrantEnvConfig,
} from "./fhenix-grant-env.js";

process.stdout.write("murmur fhenix grant env smoke\n");

const KEY_A = "0x" + "11".repeat(32);
const KEY_B = "0x" + "22".repeat(32);
const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";

// Default OFF: no config, no throw, even with a fully-populated env.
assert.equal(
  loadFhenixGrantEnvConfig({
    FHENIX_RPC_URL: "https://rpc.example",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_GRANT_PRIVATE_KEY: KEY_A,
  }),
  null,
  "default OFF returns null",
);

function expectError(env: NodeJS.ProcessEnv, key: string, note: string): void {
  let thrownKey: string | null = null;
  try {
    loadFhenixGrantEnvConfig(env, { enabled: true, contractAddress: CONTRACT });
  } catch (err) {
    assert.ok(err instanceof FhenixGrantConfigError, `${note}: FhenixGrantConfigError`);
    thrownKey = (err as FhenixGrantConfigError).key;
  }
  assert.equal(thrownKey, key, note);
}

// Fail-closed: enabled but missing RPC / chain / key.
expectError(
  { FHENIX_CHAIN_ID: "84532", FHENIX_GRANT_PRIVATE_KEY: KEY_A },
  "FHENIX_RPC_URL",
  "missing rpc throws",
);
expectError(
  { FHENIX_RPC_URL: "https://rpc.example", FHENIX_GRANT_PRIVATE_KEY: KEY_A },
  "FHENIX_CHAIN_ID",
  "missing chain id throws",
);
expectError(
  { FHENIX_RPC_URL: "https://rpc.example", FHENIX_CHAIN_ID: "84532" },
  "FHENIX_GRANT_PRIVATE_KEY",
  "missing grant key throws",
);

// Key isolation: grant key must differ from relayer and reveal keys.
expectError(
  {
    FHENIX_RPC_URL: "https://rpc.example",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_GRANT_PRIVATE_KEY: KEY_A,
    FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: KEY_A,
  },
  "FHENIX_GRANT_PRIVATE_KEY",
  "grant == relayer rejected",
);
expectError(
  {
    FHENIX_RPC_URL: "https://rpc.example",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_GRANT_PRIVATE_KEY: KEY_A,
    FHENIX_REVEAL_PRIVATE_KEY: KEY_A,
  },
  "FHENIX_GRANT_PRIVATE_KEY",
  "grant == reveal rejected",
);

// Happy path: distinct keys, explicit contract, defaults applied.
const config = loadFhenixGrantEnvConfig(
  {
    FHENIX_RPC_URL: "https://rpc.example",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_GRANT_PRIVATE_KEY: KEY_A,
    FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: KEY_B,
    FHENIX_REVEAL_PRIVATE_KEY: "0x" + "33".repeat(32),
  },
  { enabled: true, contractAddress: CONTRACT },
);
assert.ok(config, "happy path returns config");
assert.equal(config.chainId, 84532);
assert.equal(config.contractAddress.toLowerCase(), CONTRACT.toLowerCase());
assert.equal(config.salesSafetySeconds, 180, "default sales safety margin");
assert.equal(config.confirmations, 2);
assert.equal(config.maxGrantAttempts, 5, "default max grant broadcasts");
assert.equal(config.grantRebroadcastDelaySeconds, 30, "default re-broadcast grace");
assert.equal(config.settlementUnknownMaxAttempts, 8, "default settlement-unknown budget");
assert.equal(config.priceAtoms, "10000", "default flat access price in atoms");
assert.equal(config.currency, "USDC");
assert.equal(config.pricingVersion, "v1");
assert.equal(config.chain.grantorAddress, config.grantorAddress);
assert.ok(config.grantorAddress.startsWith("0x"));

process.stdout.write("OK fhenix grant env smoke\n");
