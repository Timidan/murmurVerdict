// ─── useFunnelEmit — fire-and-forget onboarding funnel emit (Phase 7d) ─────
//
// Single entry point for "emit a funnel event from a page". Wraps three
// concerns the call-sites otherwise duplicate:
//
//   1. Get the Privy access token. The /v1/account/events route requires
//      a Privy bearer; emits before the user signs in are silently dropped
//      (we can't attribute them anyway — landing.viewed is the one
//      unauthenticated exception; see ANON_KINDS below for how it
//      survives the no-token path).
//   2. Suppress duplicate emits. React StrictMode double-invokes effects
//      in dev, and the auth bootstrap re-fires once-per-bootstrap. Both
//      paths would otherwise double-emit. We dedupe in-process by the
//      (kind, serialized-attributes) tuple — the server doesn't care
//      about duplicates (the funnel query bucketizes), but the client
//      cares about not amplifying noise.
//   3. Swallow ALL errors. This is analytics; surfacing a "couldn't
//      emit landing.viewed" toast at a confused new user makes the
//      product worse. Network drops, 401s, schema-mismatches — they all
//      flow into a silent console.debug + carry on.
//
// Usage:
//
//   const emit = useFunnelEmit();
//   useEffect(() => { emit("landing.viewed"); }, [emit]);
//
// The returned `emit` is stable across renders (useCallback), so passing
// it to a useEffect dep array is safe.

import { useCallback, useRef } from "react";
import { getAccessToken } from "@privy-io/react-auth";
import { isPrivyConfigured } from "../auth/PrivyProvider.js";
import { verdictApi, type FunnelEventKind } from "../api.js";

/**
 * Kinds the dashboard is allowed to emit without an authenticated session.
 * The /v1/account/events route still 401s on these — we just don't even
 * try to attach a token. Used so `landing.viewed` instrumentation works
 * for the anonymous visitor case (which is the entire point of the
 * "landing → compete" funnel measurement).
 *
 * Until the route supports anonymous emits we hold them in a client-side
 * buffer; once the user signs in, a future Phase 8 sweep can flush. For
 * 7d we just no-op the unauthenticated path so the prod build doesn't
 * spew 401s into the console.
 */
const ANON_KINDS: ReadonlySet<FunnelEventKind> = new Set([
  "landing.viewed",
]);

export function useFunnelEmit(): (
  kind: FunnelEventKind,
  attributes?: Record<string, unknown>,
) => Promise<void> {
  // Dedupe key set — string of `${kind}:${JSON.stringify(attrs)}`. The
  // ref persists across renders without re-triggering effects.
  const seenRef = useRef<Set<string>>(new Set());

  return useCallback(
    async (kind: FunnelEventKind, attributes?: Record<string, unknown>) => {
      // Build the dedupe key first. Order of attribute keys is preserved
      // by JSON.stringify in the same insertion order; for the funnel
      // path our attributes are tiny (one or two keys) so this is fine.
      const dedupeKey = `${kind}:${attributes ? JSON.stringify(attributes) : ""}`;
      if (seenRef.current.has(dedupeKey)) return;
      seenRef.current.add(dedupeKey);

      // Don't bother emitting when Privy isn't configured at all — the
      // route would 401 every time and the network panel would fill with
      // red. This matches useAccount's "no privy = silently inert" posture.
      if (!isPrivyConfigured()) {
        if (typeof console !== "undefined") {
          // Keep this at debug level — local dev devs see it, prod silent.
          console.debug(`[funnel] privy not configured, skipping ${kind}`);
        }
        return;
      }

      let token: string | null;
      try {
        token = await getAccessToken();
      } catch {
        token = null;
      }

      if (!token) {
        if (ANON_KINDS.has(kind)) {
          // Anonymous emit — can't reach the route without a bearer.
          // Drop on the floor; a future phase can buffer + flush on
          // sign-in. The dedupe set still captured this attempt so we
          // don't keep retrying.
          if (typeof console !== "undefined") {
            console.debug(`[funnel] anon ${kind} — dropped (no privy session)`);
          }
          return;
        }
        // Authenticated kinds without a token: not yet ready, drop.
        return;
      }

      try {
        await verdictApi.postFunnelEvent(token, kind, attributes);
      } catch (err) {
        // Swallow. Analytics MUST NOT bubble into the UI. We log at debug
        // so a developer running `localStorage.debug = true` can trace
        // funnel emit failures without spamming users' consoles.
        if (typeof console !== "undefined") {
          console.debug(`[funnel] emit ${kind} failed`, err);
        }
      }
    },
    [],
  );
}
