import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import {
  loadOperatorObservabilityRuntime,
  loadOperatorObservabilityRuntimeConfig,
} from "./operator-observability-runtime.js";

const db = {} as Database.Database;
const priorFhenixRpcUrl = process.env.FHENIX_RPC_URL;
const priorFhenixChainId = process.env.FHENIX_CHAIN_ID;
const priorAlertWebhook = process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL;
const priorPolymarketGammaEnabled = process.env.MURMUR_POLYMARKET_GAMMA_ENABLED;
const now = () => new Date("2026-05-15T12:00:00Z");

process.env.FHENIX_RPC_URL = "http://ambient-fhenix.invalid";
process.env.FHENIX_CHAIN_ID = "84532";
process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL = "https://ambient-alert.invalid";
process.env.MURMUR_POLYMARKET_GAMMA_ENABLED = "false";

try {
  const disabledConfig = loadOperatorObservabilityRuntimeConfig(db, 99, {
    FHENIX_CANARY_ENABLED: "false",
    POLYMARKET_CANARY_ENABLED: "false",
    MURMUR_OPERATOR_ALERT_WEBHOOK_URL: "https://configured-alert.invalid",
    MURMUR_OPERATOR_ALERT_SECRET: "configured-secret",
    MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "1234",
  }, {
    now,
  });
  const disabled = loadOperatorObservabilityRuntime(db, 99, {
    config: disabledConfig,
    now,
  });

  assert.equal(disabled.liveCanaries.hasEnabledChecks(), false);
  assert.equal(
    disabled.operatorAlertSink.webhookUrl,
    "https://configured-alert.invalid",
  );
  assert.equal(disabled.operatorAlertSink.secret, "configured-secret");
  assert.equal(disabled.operatorAlertSink.timeoutMs, 1234);

  const fhenixOnlyConfig = loadOperatorObservabilityRuntimeConfig(db, 99, {
    FHENIX_RPC_URL: "http://configured-fhenix.invalid",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_SEALED_VERDICTS_ADDRESS:
      "0x1111111111111111111111111111111111111111",
    POLYMARKET_CANARY_ENABLED: "false",
  }, {
    fhenixSealedVerdictsAddress:
      "0x2222222222222222222222222222222222222222",
    now,
  });
  const fhenixOnly = loadOperatorObservabilityRuntime(db, 99, {
    config: fhenixOnlyConfig,
    now,
  });

  assert.equal(
    fhenixOnlyConfig.liveCanaries.fhenix.contractAddress,
    "0x2222222222222222222222222222222222222222",
  );
  assert.equal(fhenixOnly.liveCanaries.hasEnabledChecks(), true);
  assert.equal(fhenixOnly.operatorAlertSink.webhookUrl, undefined);

  const nullFhenixAddressConfig = loadOperatorObservabilityRuntimeConfig(db, 99, {
    FHENIX_RPC_URL: "http://configured-fhenix.invalid",
    FHENIX_CHAIN_ID: "84532",
    FHENIX_SEALED_VERDICTS_ADDRESS:
      "0x3333333333333333333333333333333333333333",
    POLYMARKET_CANARY_ENABLED: "false",
  }, {
    fhenixSealedVerdictsAddress: null,
    now,
  });
  assert.equal(
    nullFhenixAddressConfig.liveCanaries.fhenix.contractAddress,
    null,
  );

  const parsedPolymarketConfig = loadOperatorObservabilityRuntimeConfig(
    db,
    99,
    {
      FHENIX_CANARY_ENABLED: "false",
      MURMUR_POLYMARKET_GAMMA_ENABLED: "false",
    },
    {
      now,
      polymarketGammaEnabled: true,
    },
  );
  const parsedPolymarket = loadOperatorObservabilityRuntime(db, 99, {
    config: parsedPolymarketConfig,
    now,
  });

  assert.equal(parsedPolymarket.liveCanaries.hasEnabledChecks(), true);
  assert.equal(
    parsedPolymarket.liveCanaries.snapshot().checks.find(
      (check) => check.name === "polymarket_gamma",
    )?.status,
    "fail",
  );
} finally {
  if (priorFhenixRpcUrl === undefined) delete process.env.FHENIX_RPC_URL;
  else process.env.FHENIX_RPC_URL = priorFhenixRpcUrl;
  if (priorFhenixChainId === undefined) delete process.env.FHENIX_CHAIN_ID;
  else process.env.FHENIX_CHAIN_ID = priorFhenixChainId;
  if (priorAlertWebhook === undefined) {
    delete process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL;
  } else {
    process.env.MURMUR_OPERATOR_ALERT_WEBHOOK_URL = priorAlertWebhook;
  }
  if (priorPolymarketGammaEnabled === undefined) {
    delete process.env.MURMUR_POLYMARKET_GAMMA_ENABLED;
  } else {
    process.env.MURMUR_POLYMARKET_GAMMA_ENABLED = priorPolymarketGammaEnabled;
  }
}

console.log("operator-observability-runtime smoke ok");
