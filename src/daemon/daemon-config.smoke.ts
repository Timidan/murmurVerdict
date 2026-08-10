import assert from "node:assert/strict";

import {
  DaemonConfigError,
  loadDaemonRuntimeConfig,
} from "./daemon-config.js";
import { MurmurDatabaseBootstrapConfigError } from "../verdict/db-bootstrap.js";

const config = loadDaemonRuntimeConfig({
  PORT: "0",
  OPENSERV_API_KEY: "configured-openserv-api-key",
  RESOLVER_TICK_SEC: "1.5",
  FHENIX_EVENT_TICK_SEC: "2",
  FHENIX_GATEWAY_TICK_SEC: "3",
  FEED_SLA_TICK_SEC: "4",
  LIVE_CANARY_TICK_SEC: "5",
  OPERATOR_ALERT_TICK_SEC: "6",
  DASHBOARD_ORIGIN: "https://one.example, https://two.example",
  MURMUR_REQUIRE_LIVE_CANARIES: "1",
  MURMUR_POLYMARKET_GAMMA_ENABLED: "true",
  FHENIX_REVEAL_GRACE_SEC: "123",
});

assert.equal(config.port, 0);
assert.equal(config.trustProxyHops, 0);
assert.equal(config.dbPath, "./data/verdict.db");
assert.equal(config.requireLiveCanaries, true);
assert.equal(config.polymarketGammaEnabled, true);
assert.equal(config.resolverTickSec, 1.5);
assert.equal(config.intervals.resolverMs, 1_500);
assert.equal(config.intervals.fhenixEventMs, 2_000);
assert.equal(config.intervals.fhenixGatewayMs, 3_000);
assert.equal(config.intervals.feedSlaMs, 4_000);
assert.equal(config.intervals.liveCanaryMs, 5_000);
assert.equal(config.intervals.operatorAlertMs, 6_000);
assert.equal(config.operatorFhenixLifecycleQueryDefaults.fhenixRevealGraceSec, 123);
assert.deepEqual(config.dashboardCors, {
  kind: "allowlist",
  origins: ["https://one.example", "https://two.example"],
});

assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", PORT: "-1" }),
  (err) => err instanceof DaemonConfigError && err.key === "PORT",
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", RESOLVER_TICK_SEC: "0" }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "RESOLVER_TICK_SEC",
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", MURMUR_REQUIRE_LIVE_CANARIES: "yes" }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "MURMUR_REQUIRE_LIVE_CANARIES",
);
// The Gamma flag is a KILL SWITCH (single shared derivation): default ON,
// disabled only on an explicit false/0/no. An unrecognized value is tolerated
// as ON rather than throwing — this is what keeps daemon-config, the live
// canaries, and the API router in agreement.
assert.equal(
  loadDaemonRuntimeConfig({
    OPENSERV_API_KEY: "test",
    MURMUR_POLYMARKET_GAMMA_ENABLED: "enabled",
  }).polymarketGammaEnabled,
  true,
);
assert.equal(
  loadDaemonRuntimeConfig({
    OPENSERV_API_KEY: "test",
    MURMUR_POLYMARKET_GAMMA_ENABLED: "no",
  }).polymarketGammaEnabled,
  false,
);
assert.equal(
  loadDaemonRuntimeConfig({
    OPENSERV_API_KEY: "test",
    MURMUR_POLYMARKET_GAMMA_ENABLED: "false",
  }).polymarketGammaEnabled,
  false,
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", DASHBOARD_ORIGIN: "," }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "DASHBOARD_ORIGIN",
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", VERDICT_DB_PATH: "" }),
  (err) =>
    err instanceof MurmurDatabaseBootstrapConfigError &&
    err.key === "VERDICT_DB_PATH",
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", FHENIX_REVEAL_GRACE_SEC: "forever" }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "FHENIX_REVEAL_GRACE_SEC",
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", FHENIX_REVEAL_GRACE_SEC: "2592001" }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "FHENIX_REVEAL_GRACE_SEC",
);
assert.throws(
  () =>
    loadDaemonRuntimeConfig({
      OPENSERV_API_KEY: "launchpad-api-key",
      OPENSERV_LAUNCHPAD_ENABLED: "true",
      OPENSERV_LAUNCHPAD_PORT: "70000",
    }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "OPENSERV_LAUNCHPAD_PORT",
);
assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test", OPENSERV_LAUNCHPAD_ENABLED: "yes" }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "OPENSERV_LAUNCHPAD_ENABLED",
);

const openServDisabled = loadDaemonRuntimeConfig({
  OPENSERV_LAUNCHPAD_ENABLED: "false",
});
assert.equal(openServDisabled.openServLaunchpad.enabled, false);
assert.equal(openServDisabled.openServLaunchpad.apiKey, null);

const openServAbsent = loadDaemonRuntimeConfig({});
assert.equal(openServAbsent.openServLaunchpad.enabled, false);
assert.equal(openServAbsent.openServLaunchpad.apiKey, null);

const oneTrustedProxy = loadDaemonRuntimeConfig({
  MURMUR_TRUST_PROXY_HOPS: "1",
});
assert.equal(oneTrustedProxy.trustProxyHops, 1);
assert.throws(
  () => loadDaemonRuntimeConfig({ MURMUR_TRUST_PROXY_HOPS: "-1" }),
  (err) => err instanceof DaemonConfigError && err.key === "MURMUR_TRUST_PROXY_HOPS",
);

assert.throws(
  () => loadDaemonRuntimeConfig({ OPENSERV_LAUNCHPAD_ENABLED: "true" }),
  (err) => err instanceof DaemonConfigError && err.key === "OPENSERV_API_KEY",
);

// ─── Privy webhook signing secret (inbound transfer receiver) ────────────────
// Unset → receiver disabled (null); the route fail-closes to 503.
assert.equal(loadDaemonRuntimeConfig({}).privyWebhookSigningSecret, null);

// Set together with PRIVY_APP_ID + PRIVY_APP_SECRET → configured (passthrough).
assert.equal(
  loadDaemonRuntimeConfig({
    PRIVY_APP_ID: "privy-app",
    PRIVY_APP_SECRET: "privy-secret",
    PRIVY_WEBHOOK_SIGNING_SECRET: "whsec_dGVzdA==",
  }).privyWebhookSigningSecret,
  "whsec_dGVzdA==",
);

// Set WITHOUT PRIVY_APP_ID / PRIVY_APP_SECRET → hard config error (must not
// pretend the receiver is enabled when the verifier has no Privy client).
assert.throws(
  () =>
    loadDaemonRuntimeConfig({
      PRIVY_WEBHOOK_SIGNING_SECRET: "whsec_dGVzdA==",
    }),
  (err) => err instanceof DaemonConfigError && err.key === "PRIVY_APP_ID",
);

// ── The cohort cap must never silently become 0 ─────────────────────────────
// docker-compose renders an UNSET variable as the empty string, which is not
// nullish — so `??` skipped the FHENIX_GRANT_MAX_ARMED_PER_CALL fallback and
// the blank reached parseIntegerRange, which returned its fallback without
// validating it. A cap of 0 makes every cohort look full, so a clean Docker
// deployment following .env.example could not sell any decrypt access.
const DISCOVERY_BASE = {
  OPENSERV_API_KEY: "test",
  POLYMARKET_DISCOVERY_ENABLED: "true",
  POLYMARKET_GAMMA_ENABLED: "true",
  FHENIX_GATEWAY_ENABLED: "true",
  FHENIX_RPC_URL: "https://rpc.example",
  FHENIX_CHAIN_ID: "84532",
  FHENIX_GATEWAY_RELAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  FHENIX_SEALED_VERDICTS_ADDRESS: `0x${"22".repeat(20)}`,
  // A gateway seals calls, and sealing freezes murmur's cut onto them, so the
  // fee is required alongside the relayer.
  MURMUR_PROTOCOL_FEE_BPS: "1000",
};
// ONE name for the cap. POLYMARKET_DISCOVERY_MAX_ARMED_PER_CALL was a second
// name for the same number and is gone; the two disagreeing meant discovery
// stamped a series cap eligibility would not honour.
assert.equal(
  loadDaemonRuntimeConfig({
    ...DISCOVERY_BASE,
    FHENIX_GRANT_MAX_ARMED_PER_CALL: "25",
  }).polymarketDiscovery.maxArmedPerCall,
  25,
);
assert.equal(
  loadDaemonRuntimeConfig({
    ...DISCOVERY_BASE,
    FHENIX_GRANT_MAX_ARMED_PER_CALL: "25",
    // Ignored — the old name no longer participates.
    POLYMARKET_DISCOVERY_MAX_ARMED_PER_CALL: "999",
  }).polymarketDiscovery.maxArmedPerCall,
  25,
  "the retired name must not override the live one",
);
assert.throws(
  () =>
    loadDaemonRuntimeConfig({
      ...DISCOVERY_BASE,
      FHENIX_GRANT_MAX_ARMED_PER_CALL: "",
    }),
  (err) =>
    err instanceof DaemonConfigError &&
    err.key === "FHENIX_GRANT_MAX_ARMED_PER_CALL",
  "enabled discovery with no cap refuses to start",
);
// Disabled discovery must not force an operator to state a cap it never uses.
assert.equal(
  loadDaemonRuntimeConfig({ OPENSERV_API_KEY: "test" }).polymarketDiscovery.enabled,
  false,
);

console.log("daemon-config smoke ok");
