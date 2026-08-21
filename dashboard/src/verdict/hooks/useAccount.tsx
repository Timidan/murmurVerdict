// ─── useAccount — Privy session + Murmur backend bridge ─────────────────────
//
// Combines:
//   1) Privy auth state (`usePrivy()` → user, ready, authenticated, login, logout)
//   2) An access-token-aware getter (`getAccessToken()`) used by the API client
//   3) /v1/account/session + /v1/account/agents — exchanged on first authed
//      render so the dashboard has an `account_id` and an agent list.
//
// Architecture (2026-05-22 lift): the state engine lives in a single React
// Context provided by <AccountProvider> (mounted in AccountShell). Every
// consumer calling `useAccount()` reads from that one provider, so a
// `refreshAgents()` call in one panel updates every panel — no callback
// prop drilling required.
//
// Before the lift, each `useAccount()` call instantiated its OWN useState
// engine. ControllerWalletPanel's refresh wouldn't propagate to its
// sibling RuntimeKeysPanel. The interim fix was
// to pass `onAgentChanged` callbacks; the provider supersedes that.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  usePrivy,
  getAccessToken,
  type LinkedAccountWithMetadata,
} from "@privy-io/react-auth";
import { verdictApi, type AccountAgent, type AccountSession } from "../api.js";
import { isPrivyConfigured } from "../auth/PrivyProvider.js";
import { useFunnelEmit } from "./useFunnelEmit.js";

export interface UseAccountResult {
  /** True iff VITE_PRIVY_APP_ID is set at build time. */
  configured: boolean;
  /** True after Privy has finished its initial auth bootstrap. */
  ready: boolean;
  /** True iff the user is signed in to Privy. */
  isAuthenticated: boolean;
  /** Active backend session row (after /v1/account/session succeeds). */
  session: AccountSession | null;
  /** Agents owned by this account. Empty array when none yet. */
  agents: AccountAgent[];
  /** True while the /v1/account/* round trip is in flight. */
  loading: boolean;
  /** Most recent error from the backend session/list calls. */
  error: string | null;
  /**
   * True once murmur says this account is closed (migration 073).
   *
   * A closed account is refused on every account route except
   * GET /v1/account/session, so the bootstrap's POST fails with 403 and the
   * agent list never loads. Without this flag the dashboard would render an
   * empty page and an error string — indistinguishable from an outage. With
   * it, AccountPage renders the terminal screen instead.
   */
  deactivated: boolean;
  deactivatedAt: string | null;
  /** Privy DID-style user identifier, when authenticated. */
  userId: string | null;
  /** Best-effort email surfaced by Privy on the user object. */
  email: string | null;
  /**
   * Every account linked to this Privy user, camelCase
   * `LinkedAccountWithMetadata[]`. Includes login identities (email, OAuth,
   * external wallets) as well as non-login entries (embedded/smart wallets,
   * passkey, phone) — consumers filter to what they need. Empty when unauthed.
   */
  readonly linkedAccounts: readonly LinkedAccountWithMetadata[];
  /** Trigger Privy's hosted login modal. */
  signIn: () => void;
  /** Sign out of Privy + clear local agent cache. */
  signOut: () => Promise<void>;
  /** Re-fetch /v1/account/agents (useful after create/rotate in 7b/c). */
  refreshAgents: () => Promise<void>;
}

const AccountContext = createContext<UseAccountResult | null>(null);

/**
 * Internal state engine — used only inside <AccountProvider>. Do not export.
 * The shape of the returned object is the public surface for consumers via
 * `useAccount()`.
 */
function useAccountState(): UseAccountResult {
  const configured = isPrivyConfigured();

  // Privy hook is safe to call even when the provider isn't mounted —
  // it returns a no-op default that reports `ready: false`. But to keep
  // the hook order stable we never branch on `configured` before calling.
  const privy = usePrivy();
  // useFunnelEmit is hook-stable and returns a memoized callback;
  // it never re-fires its own emits across renders (dedupe is internal).
  const emitFunnel = useFunnelEmit();

  const [session, setSession] = useState<AccountSession | null>(null);
  const [agents, setAgents] = useState<AccountAgent[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [deactivated, setDeactivated] = useState<boolean>(false);
  const [deactivatedAt, setDeactivatedAt] = useState<string | null>(null);

  // Guard against duplicate /session POSTs across StrictMode double-renders
  // and rapid re-auth toggles. We only run the bootstrap once per
  // (authenticated && configured) edge.
  const bootstrappedRef = useRef<string | null>(null);

  const fetchAgents = useCallback(async (): Promise<void> => {
    if (!configured || !privy.authenticated) return;
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("no_access_token");
        return;
      }
      const { agents: rows } = await verdictApi.getAccountAgents(token);
      setAgents(rows);
    } catch (e) {
      setError((e as Error).message ?? "fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [configured, privy.authenticated]);

  // Exchange the Privy access token for a backend session, then list agents.
  useEffect(() => {
    if (!configured) return;
    if (!privy.ready) return;
    if (!privy.authenticated) {
      bootstrappedRef.current = null;
      setSession(null);
      setAgents([]);
      return;
    }
    const did = privy.user?.id ?? "anon";
    // Skip only when a PRIOR attempt fully SUCCEEDED — the latch is set at the
    // end of the async block below, after setAgents commits. Setting it HERE
    // (before the fetch) was the bug: React StrictMode runs setup→cleanup→setup
    // in dev, so the first attempt got cancelled, the second saw the latch and
    // bailed, and `agents` stayed [] forever with no retry path.
    if (bootstrappedRef.current === did) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) {
          if (!cancelled) setError("no_access_token");
          return;
        }
        const s = await verdictApi.postAccountSession(token);
        if (cancelled) return;
        setSession(s);
        // fire privy.signed_in once per authenticated edge.
        //
        // Now that AccountProvider mounts a single useAccountState per
        // AccountShell, the per-mount inflation that originally
        // fixed is no longer possible: there is exactly one instance
        // for the whole /account/* tree. We keep the localStorage
        // latch as a defense-in-depth measure in case AccountShell is
        // remounted by a future route change.
        const signedInLatchKey = `murmur_funnel_signed_in:${s.privy_user_id}:${s.created ? "new" : "ret"}`;
        let alreadyEmitted = false;
        try {
          alreadyEmitted = window.localStorage.getItem(signedInLatchKey) === "1";
        } catch {
          // localStorage unavailable (private mode etc.) — fall back to
          // per-mount emit; one duplicate funnel row per session is
          // acceptable in the no-storage path.
        }
        if (!alreadyEmitted) {
          void emitFunnel("privy.signed_in", {
            first_time: s.created,
            privy_user_id: s.privy_user_id,
          });
          try {
            window.localStorage.setItem(signedInLatchKey, "1");
          } catch {
            // ignore — see above
          }
        }
        const { agents: rows } = await verdictApi.getAccountAgents(token);
        if (cancelled) return;
        setAgents(rows);
        // Latch this DID as bootstrapped ONLY here — after the agents fetch
        // has actually committed and this attempt was not cancelled. A
        // StrictMode-cancelled first pass therefore leaves the latch unset,
        // so the second pass retries and populates the list.
        bootstrappedRef.current = did;
      } catch (e) {
        if (cancelled) return;
        // The POST is a write and a closed account is refused on it, like
        // every other account write. GET /v1/account/session is the one route
        // that stays open, and it is the only way to tell "you closed this"
        // apart from "murmur is down". Ask it before reporting a failure.
        try {
          const token = await getAccessToken();
          const state = token ? await verdictApi.getAccountSession(token) : null;
          if (cancelled) return;
          if (state?.deactivated) {
            setDeactivated(true);
            setDeactivatedAt(state.deactivated_at);
            setSession({
              account_id: state.account_id,
              created: state.created,
              privy_user_id: state.privy_user_id,
            });
            setError(null);
            return;
          }
        } catch {
          // Fall through to the original failure — the closed-account probe
          // is a refinement of the message, never a new failure mode.
        }
        setError((e as Error).message ?? "session_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [configured, privy.ready, privy.authenticated, privy.user?.id, emitFunnel]);

  const signIn = useCallback(() => {
    if (!configured) return;
    privy.login();
  }, [configured, privy]);

  const signOut = useCallback(async () => {
    if (!configured) return;
    await privy.logout();
    bootstrappedRef.current = null;
    setSession(null);
    setAgents([]);
    setDeactivated(false);
    setDeactivatedAt(null);
  }, [configured, privy]);

  const email = useMemo<string | null>(() => {
    // The React SDK exposes camelCase state: a top-level `email.address` for
    // the email-OTP flow, and `linkedAccounts` (LinkedAccountWithMetadata[])
    // for everything else. The prior code read snake_case `linked_accounts`
    // off a hand-cast shape — a field the React SDK never populates — so this
    // always returned null for OAuth-only sign-ins. Prefer the direct email,
    // else scan linked accounts for an email- or google_oauth-type identity.
    const u = privy.user;
    if (!u) return null;
    if (u.email?.address) return u.email.address;
    for (const acct of u.linkedAccounts) {
      if (acct.type === "email" && typeof acct.address === "string") return acct.address;
      if (acct.type === "google_oauth" && typeof acct.email === "string") return acct.email;
    }
    return null;
  }, [privy.user]);

  return {
    configured,
    ready: configured ? privy.ready : true,
    isAuthenticated: configured ? privy.authenticated : false,
    session,
    agents,
    loading,
    error,
    deactivated,
    deactivatedAt,
    userId: privy.user?.id ?? null,
    email,
    linkedAccounts: privy.user?.linkedAccounts ?? [],
    signIn,
    signOut,
    refreshAgents: fetchAgents,
  };
}

/**
 * Mounts the single account-state engine for the /account/* subtree.
 * AccountShell renders this; consumers read via `useAccount()`.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const value = useAccountState();
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/**
 * Single source of truth for "who am I?" in the dashboard. Returns the
 * shared account state provided by <AccountProvider>. Throws if called
 * outside the provider — that's a programming error, not a runtime
 * surface to handle gracefully.
 */
export function useAccount(): UseAccountResult {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error(
      "useAccount() must be called inside <AccountProvider>. AccountShell mounts the provider for every /account/* route.",
    );
  }
  return ctx;
}
