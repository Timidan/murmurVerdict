// ─── useAccount — Privy session + Murmur backend bridge ─────────────────────
// One <AccountProvider> (mounted in AccountShell) holds the state, so
// `refreshAgents()` in one panel updates every panel.

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
   * True once an account round trip has finished, success or failure; false
   * while the next runs. Unlike `loading`, tells "landed" from "not asked yet".
   */
  settled: boolean;
  /**
   * Account is closed. Closed accounts are refused everywhere except
   * GET /v1/account/session; this lets AccountPage tell that from an outage.
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
  /** Re-fetch /v1/account/agents. */
  refreshAgents: () => Promise<void>;
}

const AccountContext = createContext<UseAccountResult | null>(null);

/** State engine; used only inside <AccountProvider>. Do not export. */
function useAccountState(): UseAccountResult {
  const configured = isPrivyConfigured();

  // Safe without the provider mounted; never branch on `configured` before it (hook order).
  const privy = usePrivy();
  const emitFunnel = useFunnelEmit();

  const [session, setSession] = useState<AccountSession | null>(null);
  const [agents, setAgents] = useState<AccountAgent[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<boolean>(false);
  const [deactivated, setDeactivated] = useState<boolean>(false);
  const [deactivatedAt, setDeactivatedAt] = useState<string | null>(null);

  // DID whose bootstrap succeeded; stops duplicate /session POSTs.
  const bootstrappedRef = useRef<string | null>(null);

  const fetchAgents = useCallback(async (): Promise<void> => {
    if (!configured || !privy.authenticated) return;
    setLoading(true);
    setError(null);
    // A retry is not a settled list: leaving this true renders "0 owned".
    setSettled(false);
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
      setSettled(true);
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
      setSettled(false);
      return;
    }
    const did = privy.user?.id ?? "anon";
    // Skip only after a prior attempt fully succeeded (latch is set below).
    if (bootstrappedRef.current === did) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setSettled(false);
      try {
        const token = await getAccessToken();
        if (!token) {
          if (!cancelled) setError("no_access_token");
          return;
        }
        const s = await verdictApi.postAccountSession(token);
        if (cancelled) return;
        setSession(s);
        // Emit privy.signed_in once; the localStorage latch survives AccountShell remounts.
        const signedInLatchKey = `murmur_funnel_signed_in:${s.privy_user_id}:${s.created ? "new" : "ret"}`;
        let alreadyEmitted = false;
        try {
          alreadyEmitted = window.localStorage.getItem(signedInLatchKey) === "1";
        } catch {
          // No localStorage: emit per mount; a duplicate row is acceptable.
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
        // Latch only after success, so a StrictMode-cancelled first pass still retries.
        bootstrappedRef.current = did;
      } catch (e) {
        if (cancelled) return;
        // A closed account fails the POST; GET /v1/account/session tells closed from down.
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
          // Fall through to the original failure.
        }
        setError((e as Error).message ?? "session_failed");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSettled(true);
        }
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
    setSettled(false);
    setDeactivated(false);
    setDeactivatedAt(null);
  }, [configured, privy]);

  const email = useMemo<string | null>(() => {
    // Direct email first, else the first email or google_oauth linked account.
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
    settled,
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

export function AccountProvider({ children }: { children: ReactNode }) {
  const value = useAccountState();
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** Shared account state from <AccountProvider>; throws outside it. */
export function useAccount(): UseAccountResult {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error(
      "useAccount() must be called inside <AccountProvider>. AccountShell mounts the provider for every /account/* route.",
    );
  }
  return ctx;
}
