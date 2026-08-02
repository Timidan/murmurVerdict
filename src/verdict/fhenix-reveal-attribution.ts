import type { FhenixRevealSource } from "./repos/fhenix-sealed-calls-repo.js";

// publishReveal is permissionless, so the reveal-event `agent` field is always
// the original call's agent — it does NOT identify who broadcast the reveal.
// Authoritative attribution therefore uses the successful publish tx `from`
// (Codex review §6):
//   from == the murmur fallback reveal EOA        -> daemon_fallback
//   from == the agent's registered controller EOA -> agent (provable self-reveal)
//   any other sender                              -> unattributed_external
//
// An unknown external sender cannot honestly be called the agent, and the
// dedicated fallback EOA is never the controller wallet, so the three buckets
// are disjoint.
export function classifyRevealSource(
  sender: string | null | undefined,
  refs: {
    daemonRevealSender?: string | null;
    controllerWallet?: string | null;
  },
): FhenixRevealSource {
  const from = normalize(sender);
  if (from && normalize(refs.daemonRevealSender) === from) {
    return "daemon_fallback";
  }
  if (from && normalize(refs.controllerWallet) === from) {
    return "agent";
  }
  return "unattributed_external";
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
