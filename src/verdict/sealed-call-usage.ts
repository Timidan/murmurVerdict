import type { UsageEvent } from "./schema.js";
import type { AuthIdentity as DispatchedAuthIdentity } from "./auth/dispatcher.js";
import { makeUsageEvent } from "./usage-event.js";

export function makeSealedCallUsage(
  agent_id: string | null,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return makeUsageEvent({
    agent_id,
    kind,
    attributes,
    occurredAt: now(),
  });
}

export function runtimeKeyUsageAttributes(
  authResult: DispatchedAuthIdentity,
): Record<string, string> {
  if (!authResult.runtime_key) return {};
  return {
    runtime_key_id: authResult.runtime_key.runtime_key_id,
    runtime_key_policy_hash: authResult.runtime_key.policy_hash,
  };
}
