import { useEffect, type ReactNode } from "react";
import { PrivyProvider } from "./PrivyProvider.js";
import { AccountProvider, useAccount } from "../hooks/useAccount.js";
import { LogoLoader } from "../components/LogoLoader.js";

/**
 * Mounts Privy and the shared <AccountProvider> once for all of `/account/*`;
 * public routes never import this module, so they stay Privy-free.
 * <AccountGuard> mounts guarded children only once authenticated, so no wallet
 * hook ever runs outside the vendor provider.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider>
      <AccountProvider>
        <AccountGuard>{children}</AccountGuard>
      </AccountProvider>
    </PrivyProvider>
  );
}

/**
 * Current SPA path + query. Legacy `#/…` hash wins, as in route.ts `parseLocation`;
 * the query is kept so `?next=` round-trips deep links.
 */
function currentAppPath(): string {
  const hash = window.location.hash;
  if (hash.startsWith("#/")) return hash.slice(1);
  return `${window.location.pathname}${window.location.search}` || "/";
}

/**
 * Single auth gate for the account area. Redirects to `/account/login?next=<dest>`
 * via `location.replace` so the guarded URL doesn't become a back-button trap.
 */
function AccountGuard({ children }: { children: ReactNode }) {
  const account = useAccount();
  const path = currentAppPath();
  const isLoginRoute = path.split("?")[0] === "/account/login";
  const blocked = !isLoginRoute && account.ready && !account.isAuthenticated;

  useEffect(() => {
    if (!blocked) return;
    const dest = encodeURIComponent(currentAppPath());
    window.location.replace(`/account/login?next=${dest}`);
  }, [blocked]);

  // Wait for Privy's bootstrap so guarded children never flash signed-out.
  if (!isLoginRoute && !account.ready) {
    return <GateScreen />;
  }
  if (blocked) {
    return <GateScreen label="redirecting to sign in…" />;
  }
  return <>{children}</>;
}

function GateScreen({ label }: { label?: string }) {
  return (
    <div className="flex-1 flex flex-col gap-3 items-center justify-center">
      <LogoLoader label={label ?? "Loading"} />
      {/* Only the redirect case says anything the mark does not already say. */}
      {label && <span className="ck-mono ck-dim">{label}</span>}
    </div>
  );
}
