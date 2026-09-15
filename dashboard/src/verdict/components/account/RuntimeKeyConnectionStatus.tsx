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
    connected: "active",
    never_connected: "binding not verified",
    idle: "idle",
    heartbeat_overdue: "heartbeat overdue",
    authorization_required: "authorization required",
    unknown: "status unavailable",
  };
  const tone = connection.status === "connected"
    ? "ck-pos"
    : connection.status === "unknown" || connection.status === "authorization_required" || connection.status === "heartbeat_overdue"
      ? "ck-neg"
      : "ck-dim";
  const action = connection.status === "authorization_required"
    ? authorizationAction(connection.reason)
    : null;
  const bindingVerified = connection.status === "connected" || connection.status === "idle" || connection.status === "heartbeat_overdue";
  return (
    <span className={`${tone} text-[12px]`} title={connection.reason ?? undefined}>
      {bindingVerified && <span className="ck-pos" title="This runtime completed a signed connection check. Authorization is still valid.">{compact ? "verified" : "binding verified"} · </span>}
      {labels[connection.status]}
      {connection.last_contact_at && (
        <span className="ck-dim"> · seen <TimeAgo iso={connection.last_contact_at} /></span>
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
  if (reason === "authorization_expired") return "refresh to check key and wallet authorization";
  return "check runtime-key authorization";
}
