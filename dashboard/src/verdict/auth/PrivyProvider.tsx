// ─── Privy provider wrapper for the dashboard ───────────────────────────────
//
// Wraps the underlying `@privy-io/react-auth` <PrivyProvider> with:
//   1) Env-driven `appId` (read from VITE_PRIVY_APP_ID).
//   2) Nothing-design styling defaults (site theme, muted UI event accent).
//   3) Login methods scoped to email + Google + wallet (per UX spec §2 step-b).
//   4) `embeddedWallets.createOnLogin = "users-without-wallets"` — every
//      signed-in user ends up with at least one wallet (auto-created if
//      they haven't linked an external one). The wallet becomes the
//      Controller Wallet for any agent they onboard via #/agent/onboard.
//
// If the env var is missing, this component does NOT throw at module import
// (that would crash the whole bundle for public routes). Instead it renders
// the children inside an inert wrapper and `useAccount()` surfaces a clear
// "Privy not configured" state on routes that need auth.

import { useEffect, useState, type ReactNode } from "react";
import { PrivyProvider as VendorPrivyProvider } from "@privy-io/react-auth";
import { PRIVY_APP_ID, isPrivyConfigured, privyAppId } from "./privy-config.js";

// Re-exported from the vendor-free leaf module so existing importers keep
// working, while public-route code (useFunnelEmit) imports them straight from
// ./privy-config.js to avoid pulling the Privy SDK into the public chunk.
export { isPrivyConfigured, privyAppId };

// Dev-only "unconfigured" warning, latched so it fires at most ONCE per tab
// session. Two layers: the module flag stops repeats within a page load
// (the provider re-renders on every route change inside the account area,
// and StrictMode + Suspense re-reveals re-run renders/effects), and
// sessionStorage stops repeats across full page loads (clean-path guard
// redirects are full navigations). Previously this warn lived in the
// render body and fired 4–12× per route.
const WARNED_STORAGE_KEY = "murmur_privy_unconfigured_warned";
let warnedUnconfigured = false;

function warnUnconfiguredOnce(): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  try {
    if (window.sessionStorage.getItem(WARNED_STORAGE_KEY) === "1") return;
    window.sessionStorage.setItem(WARNED_STORAGE_KEY, "1");
  } catch {
    // sessionStorage unavailable (privacy mode etc.) — the module flag
    // still caps this at one warning per page load.
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[PrivyProvider] VITE_PRIVY_APP_ID is unset. Auth-gated routes will render in unconfigured state.",
  );
}

interface PrivyProviderProps {
  children: ReactNode;
}

function readModalTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "paper"
    ? "light"
    : "dark";
}

/**
 * Top-level Privy provider. Mounted once per account-area session by
 * AccountShell (lazy-loaded from the Router — public routes never pull the
 * SDK). When VITE_PRIVY_APP_ID is missing in dev/preview, this renders
 * children without the Privy context — auth-gated pages still render their
 * shells, but `useAccount()` returns `{ configured: false }` so they can
 * surface a clear error.
 *
 * The intentional non-throw posture is so the public routes (landing,
 * leaderboard, today, claim flows that don't depend on Privy) keep working
 * in CI builds and offline dev where Privy creds aren't around.
 */
export function PrivyProvider({ children }: PrivyProviderProps) {
  const configured = isPrivyConfigured();

  // The sign-in modal follows the site theme. Privy reads the config when the
  // modal opens, so a theme flip before sign-in has to reach this state.
  const [modalTheme, setModalTheme] = useState<"light" | "dark">(readModalTheme);

  // Same root attribute ThemeToggle watches — a same-tab flip fires no event.
  useEffect(() => {
    const observer = new MutationObserver(() => setModalTheme(readModalTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Dev-only warning, in an effect (not the render body) so renders stay
  // pure. Quiet in prod — the LoginPage surfaces a clear user-facing
  // error already, no need to spam the console.
  useEffect(() => {
    if (!configured && import.meta.env.DEV) warnUnconfiguredOnce();
  }, [configured]);

  if (!configured) {
    return <>{children}</>;
  }
  return (
    <VendorPrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: {
          theme: modalTheme,
          accentColor: "#C87367",
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          // Auto-create an Ethereum embedded wallet for users who don't
          // link an external one. Users who DO link MetaMask / WalletConnect
          // at login skip this — Privy treats their external wallet as the
          // primary. Either way `useWallets()` always returns at least one
          // Ethereum wallet on which signMessage can run.
          ethereum: { createOnLogin: "users-without-wallets" },
          // Solana stays off — Murmur is EVM-only today.
          solana: { createOnLogin: "off" },
        },
      }}
    >
      {children}
    </VendorPrivyProvider>
  );
}
