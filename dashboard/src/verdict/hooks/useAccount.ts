// ─── useAccount — Privy session + Murmur backend bridge (Phase 7a) ──────────
//
// Combines:
//   1) Privy auth state (`usePrivy()` → user, ready, authenticated, login, logout)
//   2) An access-token-aware getter (`getAccessToken()`) used by the API client
//   3) /v1/account/session + /v1/account/agents — exchanged on first authed
//      render so the dashboard has an `account_id` and an agent list.
//
// Downstream Phase 7b/c/d pages consume this single hook rather than wiring
// `usePrivy` + the API client themselves. Keeps the auth surface area in
// exactly one place — easier to swap out (or stub for dev) later.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, getAccessToken } from "@privy-io/react-auth";
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
  /** Privy DID-style user identifier, when authenticated. */
  userId: string | null;
  /** Best-effort email surfaced by Privy on the user object. */
  email: string | null;
  /** Trigger Privy's hosted login modal. */
  signIn: () => void;
  /** Sign out of Privy + clear local agent cache. */
  signOut: () => Promise<void>;
  /** Re-fetch /v1/account/agents (useful after create/rotate in 7b/c). */
  refreshAgents: () => Promise<void>;
}

/**
 * Single source of truth for "who am I?" in the dashboard.
 *
 * Mounted-once-per-route pattern: every account-area page calls
 * `useAccount()` and gets the same memoized state machine. Privy's own
 * hooks cache the user object internally, so this is cheap to call.
 */
export function useAccount(): UseAccountResult {
  const configured = isPrivyConfigured();

  // Privy hook is safe to call even when the provider isn't mounted —
  // it returns a no-op default that reports `ready: false`. But to keep
  // the hook order stable we never branch on `configured` before calling.
  const privy = usePrivy();
  // Phase 7d — useFunnelEmit is hook-stable and returns a memoized callback;
  // it never re-fires its own emits across renders (dedupe is internal).
  const emitFunnel = useFunnelEmit();

  const [session, setSession] = useState<AccountSession | null>(null);
  const [agents, setAgents] = useState<AccountAgent[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
    if (bootstrappedRef.current === did) return;
    bootstrappedRef.current = did;

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
        // Phase 7d — fire privy.signed_in once per authenticated edge.
        //
        // Codex P2 fix — bootstrappedRef is per-hook-instance, so the
        // login → account → new-agent → integrate flow remounted
        // useAccount five times and emitted privy.signed_in once per
        // mount, inflating the funnel. Gate the emit on a localStorage
        // ratchet keyed by privy_user_id + the session.created flag, so
        // each unique signed-in edge fires exactly one emit per browser.
        // bootstrappedRef still prevents the in-mount StrictMode
        // double-run.
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
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "session_failed");
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
  }, [configured, privy]);

  const email = useMemo<string | null>(() => {
    // Privy's user shape carries linked accounts; email may live on a
    // `linked_accounts` entry of type 'email' OR on `email.address` for
    // the email-OTP flow. We surface the first one we find.
    const u = privy.user as unknown as {
      email?: { address?: string };
      linked_accounts?: Array<{ type?: string; address?: string; email?: string }>;
    } | null;
    if (!u) return null;
    if (u.email?.address) return u.email.address;
    const linked = u.linked_accounts ?? [];
    for (const acct of linked) {
      if (acct?.type === "email" && typeof acct.address === "string") return acct.address;
      if (acct?.type === "google_oauth" && typeof acct.email === "string") return acct.email;
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
    userId: privy.user?.id ?? null,
    email,
    signIn,
    signOut,
    refreshAgents: fetchAgents,
  };
}
