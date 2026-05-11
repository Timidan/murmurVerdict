import type { ReactNode } from "react";
import { PrivyProvider } from "./PrivyProvider.js";

/**
 * Mounts the Privy SDK once for the entire `/account/*` area so the SDK
 * chunk lives outside the landing/leaderboard/today bundles. A single
 * instance wraps every account route (login, account list, agent creation)
 * so navigating between them preserves Privy auth state instead of
 * remounting the provider on every hash change.
 *
 * Public routes never import this module — they get the original Privy-free
 * bundle. Codex P2 from the Phase 7a review: do not load Privy on public
 * routes.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  return <PrivyProvider>{children}</PrivyProvider>;
}
