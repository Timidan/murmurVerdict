import assert from "node:assert/strict";
import { connectionAt } from "./runtime-key-connection.js";
import type { RuntimeKeyConnection } from "../api.js";

const served = "2026-09-13T12:00:00Z";
const connection: RuntimeKeyConnection = {
  status: "connected", runtime_mode: "interactive", reason: null,
  last_heartbeat_at: served, last_contact_at: served,
  fresh_until: "2026-09-13T12:05:00Z", authorization_until: "2026-09-13T12:10:00Z",
};
assert.equal(connectionAt(connection, served, 0, 180_000).status, "connected");
assert.equal(connectionAt(connection, served, 0, 300_000).status, "idle");
assert.equal(connectionAt({ ...connection, runtime_mode: "continuous" }, served, 0, 300_000).status, "heartbeat_overdue");
assert.equal(connectionAt(connection, served, 0, 600_000).status, "authorization_required");
console.log("runtime key display freshness smoke ok");
