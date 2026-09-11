import type Database from "better-sqlite3";

import type { WireRuntimeKeyConnection } from "../types/wire-account.js";
import { agentCredentialsDisabledAt } from "./auth/accounts.js";
import { isRuntimeKeyActive, type RuntimeKeyRow } from "./auth/runtime-keys.js";
import {
  controllerWalletAttestationStatus,
  getControllerWalletForAgent,
} from "./auth/controller-wallets.js";

export const HEARTBEAT_INTERVAL_SECONDS = 60;
export const HEARTBEAT_STALE_AFTER_SECONDS = 180;

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function freshUntil(db: Database.Database, row: RuntimeKeyRow, servedAt: Date): string | null {
  const lastHeartbeatAt = row.last_heartbeat_at;
  if (!lastHeartbeatAt) return null;
  const at = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(at)) return null;
  let until = at + HEARTBEAT_STALE_AFTER_SECONDS * 1000;
  if (row.expires_at) {
    const expiry = Date.parse(row.expires_at);
    if (Number.isFinite(expiry)) until = Math.min(until, expiry);
  }
  const controller = getControllerWalletForAgent(db, row.agent_id);
  if (controller) {
    const due = Date.parse(controllerWalletAttestationStatus(controller, { checkedAt: servedAt }).reattestation_due_at);
    if (Number.isFinite(due)) until = Math.min(until, due);
  }
  return iso(new Date(until));
}

/**
 * Owner-safe presence projection. Authorization is checked at the instant the
 * list is served; revocation deliberately wins even over a fresh timestamp.
 */
export function runtimeKeyConnection(
  db: Database.Database,
  row: RuntimeKeyRow,
  servedAt: Date,
): WireRuntimeKeyConnection {
  const last_heartbeat_at = row.last_heartbeat_at;
  const fresh_until = freshUntil(db, row, servedAt);
  const unauthorized = (reason: string): WireRuntimeKeyConnection => ({
    status: "authorization_required",
    last_heartbeat_at,
    fresh_until,
    reason,
  });
  if (row.revoked_at) return unauthorized("runtime_key_revoked");
  if (agentCredentialsDisabledAt(db, row.account_id)) {
    return unauthorized("agent_credentials_disabled");
  }
  if (row.expires_at && Date.parse(row.expires_at) <= servedAt.getTime()) {
    return unauthorized("runtime_key_expired");
  }
  if (!isRuntimeKeyActive(db, { runtime_key_id: row.runtime_key_id, checkedAt: servedAt })) {
    return unauthorized("controller_wallet_reattestation_required");
  }
  if (!last_heartbeat_at) {
    return { status: "never_connected", last_heartbeat_at, fresh_until, reason: null };
  }
  const until = fresh_until ? Date.parse(fresh_until) : Number.NaN;
  if (!Number.isFinite(until) || until <= servedAt.getTime()) {
    return { status: "stale", last_heartbeat_at, fresh_until, reason: "heartbeat_stale" };
  }
  return { status: "connected", last_heartbeat_at, fresh_until, reason: null };
}

export function aggregateRuntimeKeyConnection(
  connections: readonly WireRuntimeKeyConnection[],
): WireRuntimeKeyConnection {
  const newest = (status: WireRuntimeKeyConnection["status"]) => connections
    .filter((connection) => connection.status === status)
    .sort((a, b) => Date.parse(b.fresh_until ?? "") - Date.parse(a.fresh_until ?? ""))[0];
  const connected = newest("connected");
  if (connected) return connected;
  const stale = newest("stale");
  if (stale) return stale;
  const never = newest("never_connected");
  if (never) return never;
  return connections[0] ?? {
    status: "never_connected",
    last_heartbeat_at: null,
    fresh_until: null,
    reason: null,
  };
}
