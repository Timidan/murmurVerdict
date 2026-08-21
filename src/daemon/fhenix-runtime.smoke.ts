import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { FhenixDeploymentConfigError } from "../integrations/deployments.js";
import type { FhenixGatewayClient } from "../integrations/fhenix-gateway.js";
import type { FhenixMarketRegistrar } from "../integrations/fhenix-market-registration.js";
import {
  FhenixRuntimeConfigError,
  loadFhenixRuntime,
  loadFhenixRuntimeConfig,
} from "./fhenix-runtime.js";
import { ProtocolFeeConfigError } from "../verdict/protocol-fee.js";

const db = {} as Database.Database;
const logs: unknown[][] = [];
const warns: unknown[][] = [];
const logger = {
  log: (...args: unknown[]) => logs.push(args),
  warn: (...args: unknown[]) => warns.push(args),
};

const priorRpcUrl = process.env.FHENIX_RPC_URL;
const priorChainId = process.env.FHENIX_CHAIN_ID;
const tmpDir = mkdtempSync(join(tmpdir(), "fhenix-runtime-smoke-"));

process.env.FHENIX_RPC_URL = "http://ambient.invalid";
delete process.env.FHENIX_CHAIN_ID;

try {
  // An EMPTY manifest, so nothing is derivable — this case is about a runtime
  // with no Fhenix configuration at all. The chain id now comes from
  // data/deployments.json when that names exactly one chain, so passing `{}`
  // here would silently pick up the repo's real deployment and stop testing
  // the disabled path.
  const emptyManifest = join(tmpDir, "empty-deployments.json");
  writeFileSync(emptyManifest, "[]");

  const disabled = await loadFhenixRuntime(db, {
    config: loadFhenixRuntimeConfig({ DEPLOYMENTS_MANIFEST_PATH: emptyManifest }),
    logger,
    now: () => new Date("2026-05-15T12:00:00Z"),
  });

  assert.equal(disabled.verifier, null);
  assert.equal(disabled.ingestor, null);
  assert.equal(disabled.gateway, null);
  assert.equal(disabled.chainId, null);
  assert.equal(disabled.sealedVerdictsAddress, null);
  assert.equal(warns.length, 0);

  logs.length = 0;
  const configuredConfig = loadFhenixRuntimeConfig({
    FHENIX_RPC_URL: " http://fhenix.invalid ",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_SEALED_VERDICTS_ADDRESS:
      "0x1111111111111111111111111111111111111111",
    FHENIX_ESCROW_ADDRESS: " 0x2222222222222222222222222222222222222222 ",
    FHENIX_GATEWAY_ENABLED: "FALSE",
  });
  assert.equal(configuredConfig.gatewayEnabled, false);
  assert.equal(
    configuredConfig.escrowAddress,
    "0x2222222222222222222222222222222222222222",
  );
  const configured = await loadFhenixRuntime(db, {
    config: configuredConfig,
    logger,
    now: () => new Date("2026-05-15T12:00:00Z"),
  });

  assert(configured.verifier, "configured Fhenix Runtime should build verifier");
  assert(configured.ingestor, "configured Fhenix Runtime should build ingestor");
  assert.equal(configured.gateway, null);
  assert.equal(configured.chainId, 84532);
  assert.equal(
    configured.sealedVerdictsAddress,
    "0x1111111111111111111111111111111111111111",
  );
  assert.equal(warns.length, 0);
  assert(logs.some((args) => String(args[0]).includes("Fhenix config")));

  logs.length = 0;
  const gatewayOnly = await loadFhenixRuntime(db, {
    config: {
      verifier: null,
      ingestor: null,
      revealWorker: null,
      gateway: {
        chainId: 84532,
        contractAddress: "0x1111111111111111111111111111111111111111",
        relayerAddress: "0x2222222222222222222222222222222222222222",
        client: fakeGatewayClient(),
        murmurOwnedSealer: null,
    feedRevealAcknowledged: false,
    reconcileOldFromBlock: null,
        confirmations: 1,
        retryBaseMs: 1_000,
        retryMaxMs: 2_000,
        maxAttempts: 2,
        reconcileFromBlock: 0,
        stuckAfterMs: 60_000,
        broadcastTimeoutMs: 1_000,
        marketRegistrar: fakeMarketRegistrar(),
      },
      grant: null,
      // Hand-built config, so no env parse runs; the gateway here is a fake
      // that never seals anything.
      protocolFeeBps: 1_000,
      chainId: 84532,
      sealedVerdictsAddress: "0x1111111111111111111111111111111111111111",
      escrowAddress: null,
      gatewayEnabled: true,
      revealWorkerEnabled: false,
      grantEnabled: false,
      grantReconcilerEnabled: false,
      rpcConfigured: false,
      // A seal-only daemon: no deployment-wide price, default safety margin.
      // The sellable listing excludes legacy rows rather than invent one.
      saleTerms: { legacyTerms: null, salesSafetySeconds: 180 },
    },
    gatewayTimers: {
      setTimeout: () => "gateway-timer",
      clearTimeout: () => undefined,
    },
    logger,
    now: () => new Date("2026-05-15T12:00:00Z"),
  });
  assert.equal(gatewayOnly.verifier, null);
  assert.equal(gatewayOnly.ingestor, null);
  assert(gatewayOnly.gateway, "configured Fhenix Runtime should build Gateway");
  assert(
    gatewayOnly.marketRegistrar,
    "configured Fhenix Runtime should surface the market registrar",
  );
  assert.equal(gatewayOnly.chainId, 84532);

  assert.throws(
    () => loadFhenixRuntimeConfig({ FHENIX_GATEWAY_ENABLED: "yes" }),
    (err) =>
      err instanceof FhenixRuntimeConfigError &&
      err.key === "FHENIX_GATEWAY_ENABLED",
  );
  assert.throws(
    () => loadFhenixRuntimeConfig({ FHENIX_CHAIN_ID: "not-a-chain" }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_CHAIN_ID",
  );
  assert.throws(
    () => loadFhenixRuntimeConfig({ FHENIX_CHAIN_ID: "0" }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_CHAIN_ID",
  );
  assert.throws(
    () =>
      loadFhenixRuntimeConfig({
        FHENIX_CHAIN_ID: "84532",
        FHENIX_SEALED_VERDICTS_ADDRESS: "not-an-address",
      }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_SEALED_VERDICTS_ADDRESS",
  );
  // FHENIX_CONTRACT_ADDRESS is no longer read at all — it was a second alias
  // for FHENIX_SEALED_VERDICTS_ADDRESS, and the pair could drift apart across
  // a redeploy. A malformed value here is now simply ignored rather than
  // validated, because nothing consults it.
  assert.doesNotThrow(() =>
    loadFhenixRuntimeConfig({
      FHENIX_CHAIN_ID: "84532",
      FHENIX_CONTRACT_ADDRESS: "0x1234",
    }),
  );
  assert.throws(
    () =>
      loadFhenixRuntimeConfig({
        FHENIX_CHAIN_ID: "84532",
        FHENIX_ESCROW_ADDRESS: "not-an-address",
      }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_ESCROW_ADDRESS",
  );
  assert.throws(
    () => loadFhenixRuntimeConfig({ FHENIX_GATEWAY_ENABLED: "TRUE" }),
    /FHENIX_GATEWAY_ENABLED=true requires/,
  );
  assert.throws(
    () =>
      loadFhenixRuntimeConfig({
        FHENIX_GATEWAY_ENABLED: "TRUE",
        FHENIX_RPC_URL: "http://fhenix.invalid",
        FHENIX_CHAIN_ID: "84532",
        FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        FHENIX_SEALED_VERDICTS_ADDRESS: "not-an-address",
      }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_SEALED_VERDICTS_ADDRESS",
  );

  // ── The protocol fee is required wherever a sale can begin ────────────────
  // The GATEWAY, not only paid grants: sealing a call is what freezes the
  // revenue split onto it, so a deployment that can seal must know its cut.
  const gatewayBase = {
    FHENIX_GATEWAY_ENABLED: "true",
    FHENIX_RPC_URL: "http://fhenix.invalid",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    FHENIX_SEALED_VERDICTS_ADDRESS: "0x1111111111111111111111111111111111111111",
  };
  assert.throws(
    () => loadFhenixRuntimeConfig(gatewayBase),
    (err) =>
      err instanceof ProtocolFeeConfigError &&
      /MURMUR_PROTOCOL_FEE_BPS.*required/s.test(err.message),
    "a gateway that can seal must state murmur's cut",
  );
  assert.equal(
    loadFhenixRuntimeConfig({ ...gatewayBase, MURMUR_PROTOCOL_FEE_BPS: "1000" })
      .protocolFeeBps,
    1_000,
  );
  assert.throws(
    () =>
      loadFhenixRuntimeConfig({ ...gatewayBase, MURMUR_PROTOCOL_FEE_BPS: "10001" }),
    (err) => err instanceof ProtocolFeeConfigError,
    "a fee above 100% is a typo, not a fee",
  );
  // With everything off, no fee is needed — murmur runs as a pure referee.
  assert.equal(
    loadFhenixRuntimeConfig({ DEPLOYMENTS_MANIFEST_PATH: emptyManifest })
      .protocolFeeBps,
    null,
  );
} finally {
  if (priorRpcUrl === undefined) delete process.env.FHENIX_RPC_URL;
  else process.env.FHENIX_RPC_URL = priorRpcUrl;
  if (priorChainId === undefined) delete process.env.FHENIX_CHAIN_ID;
  else process.env.FHENIX_CHAIN_ID = priorChainId;
}

console.log("fhenix-runtime smoke ok");

function fakeGatewayClient(): FhenixGatewayClient {
  return {
    getChainId: async () => 84532,
    getBlockNumber: async () => 1n,
    writeContract: async () => `0x${"4".repeat(64)}` as Hex,
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 1n,
      logs: [],
    }),
  };
}

function fakeMarketRegistrar(): FhenixMarketRegistrar {
  return {
    chainId: 84532,
    contractAddress: "0x1111111111111111111111111111111111111111",
    relayerAddress: "0x2222222222222222222222222222222222222222",
    getChainId: async () => 84532,
    getOwner: async () => "0x2222222222222222222222222222222222222222",
    hasContractCode: async () => true,
    // All-zero = not registered on-chain.
    getMarket: async () => ({
      armCloseAt: 0n,
      submissionOpenAt: 0n,
      earlyAccessCutoffAt: 0n,
      submissionCloseAt: 0n,
      resolutionAt: 0n,
      publicRevealAt: 0n,
      active: false,
    }),
    getRelayerBalanceWei: async () => 10n ** 18n,
    estimateRegisterCostWei: async () => 10n ** 13n,
    registerMarket: async () => `0x${"5".repeat(64)}` as Hex,
    waitForReceipt: async () => ({
      status: "success",
      gasUsed: 120_000n,
      effectiveGasPriceWei: 10n ** 8n,
      blockNumber: 1n,
    }),
    getReceipt: async () => null,
  };
}

rmSync(tmpDir, { recursive: true, force: true });
