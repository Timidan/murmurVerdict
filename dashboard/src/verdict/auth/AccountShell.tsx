import { useEffect, type ReactNode } from "react";
import { PrivyProvider } from "./PrivyProvider.js";
import { AccountProvider, useAccount } from "../hooks/useAccount.js";

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
 * <AccountGuard> centralizes the unauthenticated redirect for every
 * guarded /account/* screen (the login route is exempt). Guarded children
 * only mount once Privy reports a stable authenticated state, which also
 * guarantees no wallet hook (useWallets etc.) ever runs outside the
 * vendor provider — in the unconfigured state PrivyProvider renders an
 * inert wrapper, and any wallet hook reached under it logs
 * "useWallets was called outside the PrivyProvider component".
 *
 * Public routes never import this module — they get the original Privy-free
 * bundle.
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
 * Current SPA path + query. Hash form (legacy `#/…` links) wins over the
 * clean pathname — the same precedence as route.ts `parseLocation` — and
 * the query string is preserved so `?next=` round-trips deep links
 * exactly (e.g. `/account/agent/<slug>/keys`, `/account?ref=landing-cta`).
 */
function currentAppPath(): string {
  const hash = window.location.hash;
  if (hash.startsWith("#/")) return hash.slice(1);
  return `${window.location.pathname}${window.location.search}` || "/";
}

/**
 * Single auth gate for the account area. Replaces the per-page redirect
 * guards (AccountPage / AgentSettingsPage / IntegratePage / onboard kept
 * theirs as dead-code fallbacks) which each set `location.hash` and
 * produced stacked URLs like `/account#/account/login?next=%2Faccount`.
 *
 * Redirects use the clean path form `/account/login?next=<dest>` via
 * `location.replace` — a plain full-page navigation like the topbar's
 * anchor links, but without leaving the guarded URL in history as a
 * back-button trap.
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

  // Wait for Privy's auth bootstrap before mounting guarded children so
  // they never render (and immediately unrender) in a transient
  // signed-out state. Unconfigured Privy reports ready=true immediately,
  // so this branch only shows while a configured Privy SDK boots.
  if (!isLoginRoute && !account.ready) {
    return <GateScreen label="loading…" />;
  }
  if (blocked) {
    return <GateScreen label="redirecting to sign in…" />;
  }
  return <>{children}</>;
}

/** Quiet full-viewport line in the compact idiom — no spinner, no chrome. */
function GateScreen({ label }: { label: string }) {
  return (
    <div className="mmr-shell min-h-dvh bg-[var(--color-bg)] flex items-center justify-center">
      <span className="ck-mono ck-dim">{label}</span>
    </div>
  );
}
