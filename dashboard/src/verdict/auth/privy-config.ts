// ─── Privy env config — vendor-free leaf module ────────────────────────────
//
// Holds the build-time VITE_PRIVY_APP_ID read and the "is Privy configured?"
// predicate that public-route code (LandingPage → useFunnelEmit) needs.
//
// This module has ZERO imports from `@privy-io/*` (or any vendor SDK) BY
// DESIGN: importing it never drags the ~2.2MB Privy bundle into a chunk. The
// heavyweight `PrivyProvider.tsx` (which DOES import the SDK) re-uses these so
// there is a single source of truth for the app id, and `useFunnelEmit` reads
// `isPrivyConfigured` from HERE instead of from `PrivyProvider.js` — otherwise
// LandingPage would statically pull the whole Privy SDK onto the public
// /dashboard entrypoint just to fire `landing.viewed`.

/** Resolved Privy app id (trimmed), or "" when unset at build time. */
export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID?.trim() || "") as string;

/** True iff a non-empty VITE_PRIVY_APP_ID was provided at build time. */
export function isPrivyConfigured(): boolean {
  return PRIVY_APP_ID.length > 0;
}

/** The resolved Privy app id, or empty string when unset. */
export function privyAppId(): string {
  return PRIVY_APP_ID;
}
