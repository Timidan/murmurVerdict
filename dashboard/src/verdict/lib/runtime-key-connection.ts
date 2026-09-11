import type { RuntimeKeyConnection } from "../api.js";

export type RuntimeKeyDisplayConnection = RuntimeKeyConnection | {
  status: "unknown";
  last_heartbeat_at: null;
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
  if (connection.status !== "connected" || !connection.fresh_until) return connection;
  const servedMs = Date.parse(servedAt);
  const untilMs = Date.parse(connection.fresh_until);
  if (!Number.isFinite(servedMs) || !Number.isFinite(untilMs) || receivedAtMs === null) {
    return unknownConnection("invalid connection time");
  }
  const serverNow = servedMs + Math.max(0, nowMs - receivedAtMs);
  return serverNow < untilMs
    ? connection
    : { ...connection, status: "stale", reason: "heartbeat_stale" };
}

export function unknownConnection(reason = "connection status unavailable"): RuntimeKeyDisplayConnection {
  return { status: "unknown", last_heartbeat_at: null, fresh_until: null, reason };
}
