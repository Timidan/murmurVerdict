import assert from "node:assert/strict";
import type Database from "better-sqlite3";

import { startDaemonPolymarketGammaRuntime } from "./polymarket-gamma-runtime.js";

const db = {} as Database.Database;

const disabled = await startDaemonPolymarketGammaRuntime({
  db,
  enabled: false,
  nowMs: () => Date.parse("2026-06-12T10:00:00Z"),
});
assert.equal(disabled, null);

const enabled = await startDaemonPolymarketGammaRuntime({
  db,
  enabled: true,
  nowMs: () => Date.parse("2026-06-12T10:00:00Z"),
  skipTickers: true,
});
assert.ok(enabled);
assert.equal(typeof enabled.stop, "function");
enabled.stop();

console.log("polymarket-gamma-runtime smoke ok");
