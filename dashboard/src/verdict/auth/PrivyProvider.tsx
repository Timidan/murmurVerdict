// ─── Privy provider wrapper for the dashboard ───────────────────────────────
// Without VITE_PRIVY_APP_ID it renders children bare instead of throwing, and
// `useAccount()` reports "not configured".

import { useEffect, useState, type ReactNode } from "react";
import { PrivyProvider as VendorPrivyProvider } from "@privy-io/react-auth";
import { PRIVY_APP_ID, isPrivyConfigured, privyAppId } from "./privy-config.js";

// Public-route code must import these from ./privy-config.js, not here, to avoid the SDK.
export { isPrivyConfigured, privyAppId };

// Dev-only "unconfigured" warning, once per tab session: module flag per page
// load, sessionStorage across full navigations.
const WARNED_STORAGE_KEY = "murmur_privy_unconfigured_warned";
let warnedUnconfigured = false;

function warnUnconfiguredOnce(): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  try {
    if (window.sessionStorage.getItem(WARNED_STORAGE_KEY) === "1") return;
    window.sessionStorage.setItem(WARNED_STORAGE_KEY, "1");
  } catch {
    // sessionStorage unavailable; the module flag still caps it per page load.
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

export function PrivyProvider({ children }: PrivyProviderProps) {
  const configured = isPrivyConfigured();

  // The sign-in modal follows the site theme.
  const [modalTheme, setModalTheme] = useState<"light" | "dark">(readModalTheme);

  // A same-tab theme flip fires no event, so watch the attribute.
  useEffect(() => {
    const observer = new MutationObserver(() => setModalTheme(readModalTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

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
          // Guarantees `useWallets()` returns at least one Ethereum wallet.
          ethereum: { createOnLogin: "users-without-wallets" },
          // EVM-only.
          solana: { createOnLogin: "off" },
        },
      }}
    >
      {children}
    </VendorPrivyProvider>
  );
}
