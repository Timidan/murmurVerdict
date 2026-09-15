import type { RuntimeKeyConnection } from "../api.js";

export type RuntimeKeyDisplayConnection = RuntimeKeyConnection | {
  status: "unknown";
  last_heartbeat_at: null;
  last_contact_at: null;
  fresh_until: null;
  reason: string;
};

/**
 * Advance a server snapshot by elapsed browser time rather than treating an
 * old successful response as proof a process is still connected.
 */
export function connectionAt(
  connection: RuntimeKeyConnection,
  servedAt: string,
  receivedAtMs: number | null,
  nowMs = performance.now(),
): RuntimeKeyDisplayConnection {
  if (connection.status === "authorization_required") return connection;
  const servedMs = Date.parse(servedAt);
  if (!Number.isFinite(servedMs) || receivedAtMs === null) {
    return unknownConnection("invalid connection time");
  }
  const serverNow = servedMs + Math.max(0, nowMs - receivedAtMs);
  if (connection.authorization_until && Date.parse(connection.authorization_until) <= serverNow) {
    return { ...connection, status: "authorization_required", reason: "authorization_expired" };
  }
  if (connection.status !== "connected" || !connection.fresh_until) return connection;
  const untilMs = Date.parse(connection.fresh_until);
  if (!Number.isFinite(untilMs)) return unknownConnection("invalid connection time");
  return serverNow < untilMs
    ? connection
    : { ...connection, status: connection.runtime_mode === "continuous" ? "heartbeat_overdue" : "idle", reason: null };
}

export function unknownConnection(reason = "connection status unavailable"): RuntimeKeyDisplayConnection {
  return { status: "unknown", last_heartbeat_at: null, last_contact_at: null, fresh_until: null, reason };
}
