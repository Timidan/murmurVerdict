import type Database from "better-sqlite3";

import type { WireRuntimeKeyConnection } from "../types/wire-account.js";
import { agentCredentialsDisabledAt } from "./auth/accounts.js";
import { isRuntimeKeyActive, type RuntimeKeyRow } from "./auth/runtime-keys.js";
import {
  controllerWalletAttestationStatus,
  getControllerWalletForAgent,
} from "./auth/controller-wallets.js";

export const HEARTBEAT_INTERVAL_SECONDS = 60;
export const HEARTBEAT_STALE_AFTER_SECONDS = 300;

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function authorizationUntil(db: Database.Database, row: RuntimeKeyRow, servedAt: Date): string | null {
  let until = Infinity;
  if (row.expires_at) {
    const expiry = Date.parse(row.expires_at);
    if (Number.isFinite(expiry)) until = Math.min(until, expiry);
  }
  const controller = getControllerWalletForAgent(db, row.agent_id);
  if (controller) {
    const due = Date.parse(controllerWalletAttestationStatus(controller, { checkedAt: servedAt }).reattestation_due_at);
    if (Number.isFinite(due)) until = Math.min(until, due);
  }
  return Number.isFinite(until) ? iso(new Date(until)) : null;
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
  const last_contact_at = row.last_contact_at;
  const authorization_until = authorizationUntil(db, row, servedAt);
  const at = last_contact_at ? Date.parse(last_contact_at) : NaN;
  const fresh_until = Number.isFinite(at) ? iso(new Date(at + HEARTBEAT_STALE_AFTER_SECONDS * 1000)) : null;
  const presence = { last_heartbeat_at, last_contact_at, fresh_until, authorization_until, runtime_mode: row.runtime_mode };
  const unauthorized = (reason: string): WireRuntimeKeyConnection => ({
    ...presence,
    status: "authorization_required",
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
    return { ...presence, status: "never_connected", reason: null };
  }
  const until = fresh_until ? Date.parse(fresh_until) : Number.NaN;
  if (!Number.isFinite(until) || until <= servedAt.getTime()) {
    return { ...presence, status: row.runtime_mode === "continuous" ? "heartbeat_overdue" : "idle", reason: null };
  }
  return { ...presence, status: "connected", reason: null };
}

export function aggregateRuntimeKeyConnection(
  connections: readonly WireRuntimeKeyConnection[],
): WireRuntimeKeyConnection {
  const newest = (status: WireRuntimeKeyConnection["status"]) => connections
    .filter((connection) => connection.status === status)
    .sort((a, b) => Date.parse(b.fresh_until ?? "") - Date.parse(a.fresh_until ?? ""))[0];
  const connected = newest("connected");
  if (connected) return connected;
  const overdue = newest("heartbeat_overdue");
  if (overdue) return overdue;
  const idle = newest("idle");
  if (idle) return idle;
  const never = newest("never_connected");
  if (never) return never;
  return connections[0] ?? {
    status: "never_connected",
    last_heartbeat_at: null,
    last_contact_at: null,
    runtime_mode: "interactive",
    authorization_until: null,
    fresh_until: null,
    reason: null,
  };
}
