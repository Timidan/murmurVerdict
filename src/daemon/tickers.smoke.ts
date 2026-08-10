import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import { openDb } from "../verdict/db-bootstrap.js";
import { VerdictEventBus } from "../verdict/events.js";
import { startDaemonTickers } from "./tickers.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-daemon-tickers-smoke-"));
const db = openDb({ path: join(tmp, "verdict.db") });

let resolverTicks = 0;
let fhenixEventTicks = 0;
let fhenixGatewayTicks = 0;
let polymarketDiscoveryTicks = 0;
let liveCanaryTicks = 0;
const warns: unknown[][] = [];
const logger = {
  warn: (...args: unknown[]) => warns.push(args),
};
const now = () => new Date("2026-06-12T09:30:00Z");

const liveCanaries: LiveCanaryProvider = {
  hasEnabledChecks: () => false,
  snapshot: () => ({
    schema_version: 99,
    served_at: "2026-01-01T00:00:00Z",
    ok: true,
    checks: [],
  }),
  runNow: async () => {
    liveCanaryTicks += 1;
    return liveCanaries.snapshot();
  },
};

try {
  const disabledResolverRuntime = startDaemonTickers({
    db,
    events: new VerdictEventBus(),
    now,
    resolver: null,
    fhenixIngestor: null,
    fhenixGateway: null,
    fhenixRevealWorker: null,
    polymarketDiscovery: null,
    liveCanaries,
    intervals: {
      resolverMs: 10_000,
      fhenixEventMs: 10_000,
      fhenixGatewayMs: 10_000,
      fhenixRevealWorkerMs: 10_000,
      feedSlaMs: 10_000,
      liveCanaryMs: 10_000,
      operatorAlertMs: 10_000,
      polymarketDiscoveryMs: 10_000,
      statsMs: 10_000,
    },
    logger,
  });
  await disabledResolverRuntime.stop();
  assert.equal(warns.length, 1);
  assert.match(String(warns[0][0]), /resolver ticker not started/);

  const runtime = startDaemonTickers({
    db,
    events: new VerdictEventBus(),
    now,
    resolver: { tick: async () => { resolverTicks += 1; } },
    fhenixIngestor: { tick: async () => { fhenixEventTicks += 1; } },
    fhenixGateway: { tick: async () => { fhenixGatewayTicks += 1; } },
    fhenixRevealWorker: null,
    polymarketDiscovery: { tick: async () => { polymarketDiscoveryTicks += 1; } },
    liveCanaries,
    intervals: {
      resolverMs: 5,
      fhenixEventMs: 5,
      fhenixGatewayMs: 5,
      fhenixRevealWorkerMs: 5,
      feedSlaMs: 5,
      liveCanaryMs: 5,
      operatorAlertMs: 5,
      polymarketDiscoveryMs: 5,
      statsMs: 5,
    },
    logger,
  });

  await runtime.stop();
  await runtime.stop();
  await delay(25);

  assert.equal(resolverTicks, 0);
  assert.equal(fhenixEventTicks, 0);
  assert.equal(fhenixGatewayTicks, 0);
  // Discovery runs an immediate startup tick; the interval never fired.
  assert.equal(polymarketDiscoveryTicks, 1);
  assert.equal(liveCanaryTicks, 0);

  console.log("tickers smoke ok");
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}
