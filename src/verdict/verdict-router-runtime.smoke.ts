import { strict as assert } from "node:assert";

import { FhenixDeploymentConfigError } from "../integrations/deployments.js";
import type { FhenixEventVerifier } from "../integrations/fhenix-events.js";
import {
  createVerdictRouterRuntime,
} from "./verdict-router-runtime.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur verdict router runtime smoke\n");

const now = () => new Date("2026-06-12T12:00:00Z");
const env = {
  VERDICT_ADMIN_TOKEN: "admin-token",
  MURMUR_PUBLIC_URL: "https://api.example.test/",
  MURMUR_DASHBOARD_URL: "https://dashboard.example.test/",
  FHENIX_CHAIN_ID: "84532",
  FHENIX_SEALED_VERDICTS_ADDRESS: `0x${"1".repeat(40)}`,
  FHENIX_REVEAL_GRACE_SEC: "7200",
  WEBHOOK_ALLOW_HTTP: "yes",
};
const alertEnv = {
  ...env,
  MURMUR_OPERATOR_ALERT_WEBHOOK_URL: "https://alerts.example.test",
  MURMUR_OPERATOR_ALERT_SECRET: "alert-secret",
  MURMUR_OPERATOR_ALERT_TIMEOUT_MS: "9000",
};

const runtime = createVerdictRouterRuntime({ env: alertEnv, now });
assert.equal(runtime.now().toISOString(), "2026-06-12T12:00:00.000Z");
assert.equal(runtime.adminAuth.adminEnabled, true);
assert.deepEqual(runtime.publicOrigin, {
  publicApiUrl: "https://api.example.test",
  dashboardUrl: "https://dashboard.example.test",
});
assert.deepEqual(runtime.fhenixChain, {
  chainId: 84532,
  sealedVerdictsAddress: `0x${"1".repeat(40)}`,
});
assert.equal(runtime.fhenixVerifier, null);
assert.deepEqual(runtime.operatorAlertSink, {
  webhookUrl: "https://alerts.example.test",
  secret: "alert-secret",
  timeoutMs: 9000,
});
assert.deepEqual(runtime.operatorFhenixLifecycleQueryDefaults, {
  fhenixRevealGraceSec: 7200,
});
assert.deepEqual(runtime.webhookUrlPolicy, { allowHttp: true });
assert.throws(
  () => runtime.requireFhenixVerifier(),
  (err) =>
    err instanceof VerdictError &&
    err.httpStatus === 503 &&
    err.code === "oracle_unavailable",
);

const resolvedAddressRuntime = createVerdictRouterRuntime({
  env: {
    FHENIX_CHAIN_ID: "84532",
    FHENIX_SEALED_VERDICTS_ADDRESS: `0x${"2".repeat(40)}`,
  },
  fhenixChainId: 84532,
  fhenixSealedVerdictsAddress: `0x${"3".repeat(40)}`,
  now,
});
assert.deepEqual(resolvedAddressRuntime.fhenixChain, {
  chainId: 84532,
  sealedVerdictsAddress: `0x${"3".repeat(40)}`,
});

const nullAddressRuntime = createVerdictRouterRuntime({
  env: {
    FHENIX_CHAIN_ID: "84532",
    FHENIX_SEALED_VERDICTS_ADDRESS: `0x${"4".repeat(40)}`,
  },
  fhenixChainId: 84532,
  fhenixSealedVerdictsAddress: null,
  now,
});
assert.deepEqual(nullAddressRuntime.fhenixChain, {
  chainId: 84532,
  sealedVerdictsAddress: null,
});
assert.throws(
  () =>
    createVerdictRouterRuntime({
      env: {},
      fhenixChainId: 84532,
      fhenixSealedVerdictsAddress: "not-an-address",
      now,
    }),
  (err) =>
    err instanceof FhenixDeploymentConfigError &&
    err.key === "FHENIX_SEALED_VERDICTS_ADDRESS",
);
assert.throws(
  () =>
    createVerdictRouterRuntime({
      env: {
        FHENIX_CHAIN_ID: "not-a-chain",
      },
      now,
    }),
  (err) =>
    err instanceof FhenixDeploymentConfigError &&
    err.key === "FHENIX_CHAIN_ID",
);

const fakeVerifier = {} as FhenixEventVerifier;
const explicit = createVerdictRouterRuntime({
  env: {
    FHENIX_CHAIN_ID: "not-a-chain",
    FHENIX_RPC_URL: "https://unused.example.test",
    MURMUR_OPERATOR_ALERT_WEBHOOK_URL: "https://ambient-alert.invalid",
  },
  fhenixChainId: null,
  fhenixVerifier: fakeVerifier,
  now,
  operatorAlertSink: null,
  operatorFhenixLifecycleQueryDefaults: { fhenixRevealGraceSec: 12 },
  webhookUrlPolicy: { allowHttp: false },
});
assert.equal(explicit.fhenixChain, null);
assert.equal(explicit.requireFhenixVerifier(), fakeVerifier);
assert.equal(explicit.operatorAlertSink, null);
assert.deepEqual(explicit.operatorFhenixLifecycleQueryDefaults, {
  fhenixRevealGraceSec: 12,
});
assert.deepEqual(explicit.webhookUrlPolicy, { allowHttp: false });

process.stdout.write("verdict router runtime smoke ok\n");
