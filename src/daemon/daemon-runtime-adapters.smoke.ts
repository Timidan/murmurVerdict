import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../verdict/db-bootstrap.js";
import { loadDaemonRuntimeConfig } from "./daemon-config.js";
import { loadDaemonRuntimeAdapters } from "./daemon-runtime-adapters.js";

const ambientEnvKeys = [
  "BASE_MAINNET_RPC_URL",
  "CHAINLINK_BASE_ETH_USD_ADDRESS",
  "FHENIX_CANARY_ENABLED",
  "FHENIX_CANARY_REQUIRE_CONTRACT_CODE",
  "FHENIX_CHAIN_ID",
  "FHENIX_RPC_URL",
  "MURMUR_NANOPAY_ENABLED",
  "MURMUR_OPERATOR_ALERT_SECRET",
  "MURMUR_OPERATOR_ALERT_TIMEOUT_MS",
  "MURMUR_OPERATOR_ALERT_WEBHOOK_URL",
  "MURMUR_POLYMARKET_GAMMA_ENABLED",
  "POLYMARKET_CANARY_CONDITION_ID",
  "POLYMARKET_CANARY_ENABLED",
  "PYTH_HERMES_ENDPOINT",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_VERIFICATION_KEY",
] as const;
const priorEnv = new Map(ambientEnvKeys.map((key) => [key, process.env[key]]));

process.env.BASE_MAINNET_RPC_URL = "https://ambient-base-rpc.invalid";
process.env.CHAINLINK_BASE_ETH_USD_ADDRESS =
  "0x9999999999999999999999999999999999999999";
process.env.FHENIX_CANARY_ENABLED = "true";
process.env.FHENIX_CANARY_REQUIRE_CONTRACT_CODE = "false";
process.env.FHENIX_RPC_URL = "http://ambient-fhenix.invalid";
process.env.FHENIX_CHAIN_ID = "84532";
process.env.MURMUR_NANOPAY_ENABLED = "true";
process.env.MURMUR_OPERATOR_ALERT_SECRET = "ambient-alert-secret";
process.env.MURMUR_OPERATOR_ALERT_TIMEOUT_MS = "9876";
process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL = "https://ambient-alert.invalid";
process.env.MURMUR_POLYMARKET_GAMMA_ENABLED = "1";
process.env.POLYMARKET_CANARY_CONDITION_ID = `0x${"6".repeat(64)}`;
process.env.POLYMARKET_CANARY_ENABLED = "true";
process.env.PYTH_HERMES_ENDPOINT = "https://ambient-pyth.invalid";
process.env.PRIVY_APP_ID = "ambient-privy-app";
process.env.PRIVY_APP_SECRET = "ambient-privy-secret";
process.env.PRIVY_VERIFICATION_KEY = "ambient-invalid-pem";

const tmp = mkdtempSync(join(tmpdir(), "murmur-daemon-runtime-adapters-smoke-"));
const db = openDb({ path: join(tmp, "verdict.db") });
const logs: string[] = [];
const warns: unknown[][] = [];
const logger = {
  log: (message: string) => logs.push(message),
  warn: (...args: unknown[]) => warns.push(args),
};
const now = () => new Date("2026-06-12T10:00:00Z");

try {
  const config = loadDaemonRuntimeConfig({
    PORT: "0",
    OPENSERV_API_KEY: "configured-openserv-api-key",
    MURMUR_OPERATOR_ALERT_SECRET: "configured-alert-secret",
    MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "1234",
    MURMUR_OPERATOR_ALERT_WEBHOOK_URL: "https://configured-alert.invalid",
  });
  const adapters = await loadDaemonRuntimeAdapters({
    config,
    db,
    env: {},
    logger,
    now,
    schemaVersion: 99,
  });

  // No oracle env at all; the resolver must still exist.
  assert(
    adapters.resolver,
    "resolver must be constructed unconditionally, with zero oracle configuration",
  );
  assert.equal(
    typeof adapters.resolver.tick,
    "function",
    "the unconditionally-constructed resolver must be tickable",
  );
  assert.equal(adapters.fhenixVerifier, null);
  assert.equal(adapters.fhenixIngestor, null);
  assert.equal(adapters.fhenixGateway, null);
  assert.equal(adapters.nanopayRuntime, null);
  // The polymarket-gamma canary is on by default, so the set is non-empty.
  assert.equal(adapters.liveCanaries.hasEnabledChecks(), true);
  assert.equal(
    adapters.operatorAlertSink.webhookUrl,
    "https://configured-alert.invalid",
  );
  assert.equal(adapters.operatorAlertSink.secret, "configured-alert-secret");
  assert.equal(adapters.operatorAlertSink.timeoutMs, 1234);
  assert.equal(adapters.privyAuth.isEnabled(), false);
  assert.equal(adapters.events.subscriberCount(), 1);

  adapters.stop();
  adapters.stop();
  assert.equal(adapters.events.subscriberCount(), 0);

  const parsedPolymarketConfig = loadDaemonRuntimeConfig({
    PORT: "0",
    OPENSERV_API_KEY: "configured-openserv-api-key",
    MURMUR_POLYMARKET_GAMMA_ENABLED: "true",
  });
  const parsedPolymarketAdapters = await loadDaemonRuntimeAdapters({
    config: parsedPolymarketConfig,
    db,
    env: {
      FHENIX_CANARY_ENABLED: "false",
      MURMUR_POLYMARKET_GAMMA_ENABLED: "false",
    },
    logger,
    now,
    schemaVersion: 99,
  });
  assert.equal(parsedPolymarketAdapters.liveCanaries.hasEnabledChecks(), true);
  assert.equal(
    parsedPolymarketAdapters.liveCanaries.snapshot().served_at,
    "2026-06-12T10:00:00Z",
  );
  parsedPolymarketAdapters.stop();

  const configuredFhenixConfig = loadDaemonRuntimeConfig({
    PORT: "0",
    OPENSERV_API_KEY: "configured-openserv-api-key",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_SEALED_VERDICTS_ADDRESS:
      "0x2222222222222222222222222222222222222222",
  });
  const configuredFhenixAdapters = await loadDaemonRuntimeAdapters({
    config: configuredFhenixConfig,
    db,
    env: {
      FHENIX_CANARY_ENABLED: "true",
      FHENIX_CANARY_REQUIRE_CONTRACT_CODE: "false",
      FHENIX_CHAIN_ID: "84532",
      FHENIX_RPC_URL: "http://configured-fhenix.invalid",
      FHENIX_SEALED_VERDICTS_ADDRESS: "not-an-address",
      POLYMARKET_CANARY_ENABLED: "false",
    },
    logger,
    now,
    schemaVersion: 99,
  });
  assert.equal(configuredFhenixAdapters.liveCanaries.hasEnabledChecks(), true);
  configuredFhenixAdapters.stop();

  assert.equal(warns.length, 0);
  // Nothing reads Base/Chainlink/Pyth env, so the daemon must not log about one.
  assert.equal(
    logs.some((line) => /BASE_MAINNET_RPC_URL|CHAINLINK|PYTH/i.test(line)),
    false,
  );

  console.log("daemon-runtime-adapters smoke ok");
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const key of ambientEnvKeys) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
