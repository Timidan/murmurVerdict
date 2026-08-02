import { strict as assert } from "node:assert";

import {
  FhenixRevealWorkerConfigError,
  loadFhenixRevealWorkerEnvConfig,
} from "./fhenix-reveal-worker-env.js";

process.stdout.write("murmur fhenix reveal worker env smoke\n");

const CONTRACT = "0x1B74A4bAb1E06Ed107780a245c85337AB9dEcD1A";
const REVEAL_KEY = "0x" + "11".repeat(32);
const RELAYER_KEY = "0x" + "22".repeat(32);

// Default OFF: no enabled flag → null (never builds clients).
assert.equal(loadFhenixRevealWorkerEnvConfig({}), null);
assert.equal(
  loadFhenixRevealWorkerEnvConfig({ FHENIX_REVEAL_WORKER_ENABLED: "false" }),
  null,
);

// Enabled without the dedicated key fails CLOSED (never silently no-ops).
assert.throws(
  () =>
    loadFhenixRevealWorkerEnvConfig({
      FHENIX_REVEAL_WORKER_ENABLED: "true",
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: "84532",
      FHENIX_SEALED_VERDICTS_ADDRESS: CONTRACT,
    }),
  (err: unknown) =>
    err instanceof FhenixRevealWorkerConfigError && err.key === "FHENIX_REVEAL_PRIVATE_KEY",
);

// Malformed private key rejected.
assert.throws(
  () =>
    loadFhenixRevealWorkerEnvConfig({
      FHENIX_REVEAL_WORKER_ENABLED: "true",
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: "84532",
      FHENIX_SEALED_VERDICTS_ADDRESS: CONTRACT,
      FHENIX_REVEAL_PRIVATE_KEY: "0xnothex",
    }),
  (err: unknown) =>
    err instanceof FhenixRevealWorkerConfigError && err.key === "FHENIX_REVEAL_PRIVATE_KEY",
);

// Reveal key MUST differ from the relayer key (nonce-contention guard).
assert.throws(
  () =>
    loadFhenixRevealWorkerEnvConfig({
      FHENIX_REVEAL_WORKER_ENABLED: "true",
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: "84532",
      FHENIX_SEALED_VERDICTS_ADDRESS: CONTRACT,
      FHENIX_REVEAL_PRIVATE_KEY: REVEAL_KEY,
      FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: REVEAL_KEY,
    }),
  (err: unknown) =>
    err instanceof FhenixRevealWorkerConfigError && err.key === "FHENIX_REVEAL_PRIVATE_KEY",
);

// Bad numeric knob fails closed.
assert.throws(
  () =>
    loadFhenixRevealWorkerEnvConfig({
      FHENIX_REVEAL_WORKER_ENABLED: "true",
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: "84532",
      FHENIX_SEALED_VERDICTS_ADDRESS: CONTRACT,
      FHENIX_REVEAL_PRIVATE_KEY: REVEAL_KEY,
      FHENIX_REVEAL_WORKER_GRACE_SEC: "-5",
    }),
  (err: unknown) =>
    err instanceof FhenixRevealWorkerConfigError && err.key === "FHENIX_REVEAL_WORKER_GRACE_SEC",
);

// Valid config builds: distinct reveal key, defaults applied, address derived.
const config = loadFhenixRevealWorkerEnvConfig({
  FHENIX_REVEAL_WORKER_ENABLED: "true",
  FHENIX_RPC_URL: "http://127.0.0.1:8545",
  FHENIX_CHAIN_ID: "84532",
  FHENIX_SEALED_VERDICTS_ADDRESS: CONTRACT,
  FHENIX_REVEAL_PRIVATE_KEY: REVEAL_KEY,
  FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: RELAYER_KEY,
});
assert.ok(config, "valid config must build");
assert.equal(config.chainId, 84532);
assert.equal(config.contractAddress.toLowerCase(), CONTRACT.toLowerCase());
assert.equal(config.graceSeconds, 300);
assert.equal(config.retryBaseMs, 5_000);
assert.equal(config.retryMaxMs, 300_000);
assert.equal(config.rebroadcastMs, 90_000);
assert.equal(config.maxJobsPerTick, 5);
assert.equal(config.maxConcurrency, 2);
assert.equal(config.tickSec, 30);
assert.equal(config.warnMs, 600_000);
assert.equal(config.escalateMs, 1_800_000);
assert.equal(config.minBalanceWei, 20_000_000_000_000_000n);
assert.equal(config.revealAddress, config.revealAddress.toLowerCase());
assert.match(config.revealAddress, /^0x[0-9a-f]{40}$/);
assert.equal(typeof config.chain.safeHead, "function");
assert.equal(typeof config.decryptor.decrypt, "function");

process.stdout.write("fhenix reveal worker env smoke ok\n");
