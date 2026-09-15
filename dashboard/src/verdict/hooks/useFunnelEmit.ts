// ─── useFunnelEmit — fire-and-forget onboarding funnel emit ────────────────
// Gets the Privy token, dedupes repeat emits, and swallows every error (analytics
// must never reach the UI). The returned `emit` is stable across renders.
//
//   const emit = useFunnelEmit();
//   useEffect(() => { emit("landing.viewed"); }, [emit]);

import { useCallback, useRef } from "react";
// Not ../auth/PrivyProvider.js: this hook is on the public chunk and must not pull the Privy SDK.
import { isPrivyConfigured } from "../auth/privy-config.js";
import { verdictApi, type FunnelEventKind } from "../api.js";

// Dynamic import keeps the Privy SDK out of public-route chunks.
async function loadGetAccessToken(): Promise<() => Promise<string | null>> {
  const mod = await import("@privy-io/react-auth");
  return mod.getAccessToken;
}

/**
 * Kinds that may fire without a session. The route still 401s without a
 * bearer, so for now a tokenless emit of these is dropped, not sent.
 */
const ANON_KINDS: ReadonlySet<FunnelEventKind> = new Set([
  "landing.viewed",
]);

export function useFunnelEmit(): (
  kind: FunnelEventKind,
  attributes?: Record<string, unknown>,
) => Promise<void> {
  // Dedupe by delivery, not attempt. deliveredRef: delivered or terminally
  // skipped. inFlightRef: awaiting now. A transient failure is in neither, so it retries.
  const deliveredRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  return useCallback(
    async (kind: FunnelEventKind, attributes?: Record<string, unknown>) => {
      const dedupeKey = `${kind}:${attributes ? JSON.stringify(attributes) : ""}`;
      if (deliveredRef.current.has(dedupeKey)) return;
      if (inFlightRef.current.has(dedupeKey)) return;

      // Unconfigured Privy can't change mid-session: terminal skip.
      if (!isPrivyConfigured()) {
        deliveredRef.current.add(dedupeKey);
        if (typeof console !== "undefined") {
          console.debug(`[funnel] privy not configured, skipping ${kind}`);
        }
        return;
      }

      inFlightRef.current.add(dedupeKey);
      try {
        let token: string | null;
        try {
          const getAccessToken = await loadGetAccessToken();
          token = await getAccessToken();
        } catch {
          token = null;
        }

        if (!token) {
          if (ANON_KINDS.has(kind)) {
            // No bearer for an anon kind: terminal skip.
            deliveredRef.current.add(dedupeKey);
            if (typeof console !== "undefined") {
              console.debug(`[funnel] anon ${kind} — dropped (no privy session)`);
            }
            return;
          }
          // No session yet: leave unmarked so a post-sign-in call retries.
          return;
        }

        await verdictApi.postFunnelEvent(token, kind, attributes);
        deliveredRef.current.add(dedupeKey);
      } catch (err) {
        // Transient: not marked, so a later call retries. Never surface to the UI.
        if (typeof console !== "undefined") {
          console.debug(`[funnel] emit ${kind} failed`, err);
        }
      } finally {
        inFlightRef.current.delete(dedupeKey);
      }
    },
    [],
  );
}
