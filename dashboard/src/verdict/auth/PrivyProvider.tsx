// ─── Privy provider wrapper for the dashboard (Phase 7a) ────────────────────
//
// Wraps the underlying `@privy-io/react-auth` <PrivyProvider> with:
//   1) Env-driven `appId` (read from VITE_PRIVY_APP_ID).
//   2) Nothing-design styling defaults (dark theme, accent #D71921).
//   3) Login methods scoped to email + Google + wallet (per UX spec §2 step-b).
//   4) `embeddedWallets.createOnLogin = "off"` — Maya path is wallet-less; the
//      wallet-tier upgrade in Phase 7c+ explicitly creates one when needed.
//
// If the env var is missing, this component does NOT throw at module import
// (that would crash the whole bundle for public routes). Instead it renders
// the children inside an inert wrapper and `useAccount()` surfaces a clear
// "Privy not configured" state on routes that need auth.

import type { ReactNode } from "react";
import { PrivyProvider as VendorPrivyProvider } from "@privy-io/react-auth";

const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID?.trim() || "") as string;

/** True iff a non-empty VITE_PRIVY_APP_ID was provided at build time. */
export function isPrivyConfigured(): boolean {
  return PRIVY_APP_ID.length > 0;
}

/** The resolved Privy app id, or empty string when unset. */
export function privyAppId(): string {
  return PRIVY_APP_ID;
}

interface PrivyProviderProps {
  children: ReactNode;
}

/**
 * Top-level Privy provider. Mount once in main.tsx. When VITE_PRIVY_APP_ID
 * is missing in dev/preview, this renders children without the Privy
 * context — auth-gated pages still render their shells, but `useAccount()`
 * returns `{ configured: false }` so they can surface a clear error.
 *
 * The intentional non-throw posture is so the public routes (landing,
 * leaderboard, today, claim flows that don't depend on Privy) keep working
 * in CI builds and offline dev where Privy creds aren't around.
 */
export function PrivyProvider({ children }: PrivyProviderProps) {
  if (!isPrivyConfigured()) {
    if (import.meta.env.DEV) {
      // Dev-only warning. Quiet in prod — the LoginPage surfaces a clear
      // user-facing error already, no need to spam the console.
      // eslint-disable-next-line no-console
      console.warn(
        "[PrivyProvider] VITE_PRIVY_APP_ID is unset. Auth-gated routes will render in unconfigured state.",
      );
    }
    return <>{children}</>;
  }
  return (
    <VendorPrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#D71921",
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          // Privy 3.x nests createOnLogin under each chain family. Maya
          // path never creates a wallet at signup — the wallet-tier
          // upgrade in Phase 7c+ provisions one explicitly when needed.
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
      }}
    >
      {children}
    </VendorPrivyProvider>
  );
}
