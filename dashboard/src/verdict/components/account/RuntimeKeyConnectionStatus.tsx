import type { RuntimeKeyDisplayConnection } from "../../lib/runtime-key-connection.js";
import { TimeAgo } from "../compact/TimeAgo.js";

export function RuntimeKeyConnectionStatus({
  connection,
  compact = false,
}: {
  connection: RuntimeKeyDisplayConnection;
  compact?: boolean;
}) {
  const labels: Record<RuntimeKeyDisplayConnection["status"], string> = {
    connected: "connected",
    never_connected: "waiting for heartbeat",
    stale: "stale",
    authorization_required: "authorization required",
    unknown: "status unavailable",
  };
  const tone = connection.status === "connected"
    ? "ck-pos"
    : connection.status === "unknown" || connection.status === "authorization_required"
      ? "ck-neg"
      : "ck-dim";
  const action = connection.status === "authorization_required"
    ? authorizationAction(connection.reason)
    : null;
  return (
    <span className={`${tone} text-[12px]`} title={connection.reason ?? undefined}>
      {compact ? labels[connection.status] : `connection · ${labels[connection.status]}`}
      {connection.last_heartbeat_at && (
        <span className="ck-dim"> · seen <TimeAgo iso={connection.last_heartbeat_at} /></span>
      )}
      {action && <span> · {action}</span>}
    </span>
  );
}

function authorizationAction(reason: string | null): string {
  if (reason === "runtime_key_revoked") return "mint a replacement key";
  if (reason === "runtime_key_expired") return "mint a fresh key";
  if (reason === "agent_credentials_disabled") return "restore agent access";
  if (reason === "controller_wallet_reattestation_required") return "re-attest the controller wallet";
  return "check runtime-key authorization";
}
