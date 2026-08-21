// ─── useFunnelEmit — fire-and-forget onboarding funnel emit ────────────────
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
// Import from the vendor-free leaf module (NOT ../auth/PrivyProvider.js) so
// this hook — pulled onto the public /dashboard chunk via LandingPage's
// landing.viewed emit — never statically drags in the ~2.2MB Privy SDK. The
// authenticated getAccessToken path stays dynamic-imported below.
// Import from the vendor-free leaf module (NOT ../auth/PrivyProvider.js) so
// this hook — pulled onto the public /dashboard chunk via LandingPage's
// landing.viewed emit — never statically drags in the ~2.2MB Privy SDK. The
// authenticated getAccessToken path stays dynamic-imported below.
import { isPrivyConfigured } from "../auth/privy-config.js";
import { verdictApi, type FunnelEventKind } from "../api.js";

// Do not statically import `getAccessToken` from
// `@privy-io/react-auth`, which dragged the entire Privy SDK into any
// chunk that referenced this hook. LandingPage in particular pulled
// the ~2MB Privy bundle onto the public-route entrypoint just to fire
// `landing.viewed`. We now dynamic-import the SDK only inside the
// authenticated emit path; the function-scoped import gets its own
// chunk that Vite splits behind the Privy entry, leaving public
// routes Privy-free.
async function loadGetAccessToken(): Promise<() => Promise<string | null>> {
  const mod = await import("@privy-io/react-auth");
  return mod.getAccessToken;
}

/**
 * Kinds the dashboard is allowed to emit without an authenticated session.
 * The /v1/account/events route still 401s on these — we just don't even
 * try to attach a token. Used so `landing.viewed` instrumentation works
 * for the anonymous visitor case (which is the entire point of the
 * "landing → compete" funnel measurement).
 *
 * Until the route supports anonymous emits we hold them in a client-side
 * buffer; once the user signs in, a later sweep can flush it. For
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
  // Dedupe by DELIVERY, not by attempt. Two refs, both persisting across
  // renders without re-triggering effects:
  //   · deliveredRef — keys we've delivered OR terminally skipped (privy
  //     unconfigured, anon-kind with no bearer). Never emitted again.
  //   · inFlightRef  — keys with an emit currently awaiting. Suppresses the
  //     StrictMode double-invoke / bootstrap re-fire without foreclosing a
  //     later retry.
  // A transient failure (token fetch drop, POST reject) or a not-signed-in-yet
  // drop for an authenticated kind leaves the key in NEITHER set, so a later
  // call (e.g. after the user signs in) retries cleanly.
  const deliveredRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  return useCallback(
    async (kind: FunnelEventKind, attributes?: Record<string, unknown>) => {
      // Build the dedupe key. Order of attribute keys is preserved by
      // JSON.stringify in insertion order; funnel attributes are tiny.
      const dedupeKey = `${kind}:${attributes ? JSON.stringify(attributes) : ""}`;
      if (deliveredRef.current.has(dedupeKey)) return;
      if (inFlightRef.current.has(dedupeKey)) return;

      // Don't bother emitting when Privy isn't configured at all — the route
      // would 401 every time. Config can't change mid-session, so this is a
      // terminal skip (mark delivered to avoid re-running the dynamic import).
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
            // Anonymous emit — can't reach the route without a bearer. Treat
            // as a terminal skip (a future phase buffers + flushes on sign-in).
            deliveredRef.current.add(dedupeKey);
            if (typeof console !== "undefined") {
              console.debug(`[funnel] anon ${kind} — dropped (no privy session)`);
            }
            return;
          }
          // Authenticated kind but no session YET — leave the key unmarked so
          // a post-sign-in call retries. (finally clears in-flight.)
          return;
        }

        await verdictApi.postFunnelEvent(token, kind, attributes);
        // Delivered exactly once.
        deliveredRef.current.add(dedupeKey);
      } catch (err) {
        // Transient failure — do NOT mark delivered; a later call retries.
        // Analytics MUST NOT bubble into the UI; log at debug only.
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
