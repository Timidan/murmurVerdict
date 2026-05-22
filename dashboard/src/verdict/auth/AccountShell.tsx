import type { ReactNode } from "react";
import { PrivyProvider } from "./PrivyProvider.js";
import { AccountProvider } from "../hooks/useAccount.js";

/**
 * Mounts the Privy SDK + the shared <AccountProvider> once for the entire
 * `/account/*` area. PrivyProvider keeps the SDK chunk outside the
 * landing/leaderboard/today bundles (Codex P2 from Phase 7a). AccountProvider
 * hoists useAccount's session+agents state so every sibling panel reads
 * from the same context — without it, sibling panels (ControllerWalletPanel,
 * RuntimeKeysPanel) each got independent state and refreshes didn't
 * propagate (codex MAJOR on Wave B; the callback-prop interim it required
 * is now redundant but kept for backward compatibility).
 *
 * Public routes never import this module — they get the original Privy-free
 * bundle.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider>
      <AccountProvider>{children}</AccountProvider>
    </PrivyProvider>
  );
}
