// ─── Privy access-token verification (V2 §7.1 casual tier) ──────────────────
//
// Verifies a Privy-issued access token against the configured app ID and
// public key. Returns a normalized claims object the rest of the system
// can route on, or `null` if Privy auth is disabled / the token is
// invalid.
//
// Why we don't throw on invalid tokens:
//   The dispatcher (auth/dispatcher.ts) needs to FALL THROUGH to the
//   legacy API-key and HMAC paths when a Privy token isn't present or
//   doesn't verify. Throwing here would force every existing client to
//   route around an exception. `null` lets the dispatcher try the next
//   auth mode cleanly.
//
// Env contract:
//   PRIVY_APP_ID            — required to enable the path
//   PRIVY_APP_SECRET        — required for SDK-side calls (not strictly
//                             needed for verifyAccessToken alone, but the
//                             SDK constructor expects it; we read it here
//                             so a misconfigured deploy fails closed at
//                             boot rather than per-request)
//   PRIVY_VERIFICATION_KEY  — required: the PEM-encoded SPKI public key
//                             from the Privy dashboard
//                             (Settings → Advanced → JWKS endpoint /
//                             verification key). MUST be the static key
//                             baked at deploy time — fetching it from the
//                             dashboard at request time defeats the point
//                             of a public-key check.
//
// What's NOT in the access token:
//   The Privy access token only carries: sub (DID), aud (app id), iss,
//   sid, iat, exp. It does NOT carry email or login_method. Those live
//   in the IDENTITY token (separate JWT) or behind a `privy.users.get()`
//   API call. For this scaffold we surface DID + sid only; downstream
//   account creation can hydrate email lazily via the identity token in
//   Phase 4 if/when we need it.
//
// Replay / CSRF posture:
//   - Privy tokens have a short exp (typically 1h). The library checks
//     `exp` for us via `jose.jwtVerify`.
//   - The token is a Bearer credential — anyone in possession can present
//     it. CSRF mitigation is the responsibility of the dispatcher's
//     calling context (browser flows must use SameSite cookies; CLI
//     flows present the token directly via Authorization header).
//   - There is NO server-side nonce table for access tokens. If we need
//     replay protection beyond the JWT exp, that lives in Phase 8's
//     EIP-712 nonce design, not here.

import type { VerifyAccessTokenResponse } from "@privy-io/node";

export interface PrivyClaims {
  /** The Privy user DID, e.g. 'did:privy:xxxxx'. Stable per user. */
  privy_user_id: string;
  /** The session ID. Useful for log correlation. */
  session_id: string;
  /** Token expiration as ISO-8601 (UTC). */
  expires_at: string;
  /**
   * Optional — derived if available. The access token does NOT carry an
   * email; this stays undefined for the scaffold. Phase 4's identity-token
   * verifier can populate it.
   */
  email?: string;
  /**
   * Optional — derived if available. Same caveat as `email`: not in the
   * access token. Set to undefined here so the type lines up with what
   * the accounts repo expects.
   */
  primary_login_method?: string;
}

/**
 * Internal: returns true if the env contract for Privy is satisfied.
 * Exported so the dispatcher and tests can branch on this without
 * re-reading process.env.
 */
export function isPrivyEnabled(): boolean {
  return (
    typeof process.env.PRIVY_APP_ID === "string" &&
    process.env.PRIVY_APP_ID.length > 0 &&
    typeof process.env.PRIVY_APP_SECRET === "string" &&
    process.env.PRIVY_APP_SECRET.length > 0 &&
    typeof process.env.PRIVY_VERIFICATION_KEY === "string" &&
    process.env.PRIVY_VERIFICATION_KEY.length > 0
  );
}

/**
 * Verify a Privy access token. Returns normalized claims or `null` if
 * Privy auth is disabled or the token did not verify.
 *
 * NOT YET WIRED — the dispatcher imports this but the dispatcher itself
 * is not mounted until Phase 4. See module header for the env contract.
 */
export async function verifyPrivyAuth(
  authToken: string,
): Promise<PrivyClaims | null> {
  if (!isPrivyEnabled()) {
    return null;
  }
  if (typeof authToken !== "string" || authToken.length < 10) {
    return null;
  }

  // Lazy dynamic import — keeps the module out of the import graph for
  // deploys that don't enable Privy. Static import would pull the SDK
  // (and its jose / hpke / svix deps) into every entrypoint regardless.
  let verifyAccessToken: (
    input: {
      access_token: string;
      app_id: string;
      verification_key: unknown;
    },
  ) => Promise<VerifyAccessTokenResponse>;
  try {
    const mod = (await import("@privy-io/node")) as {
      verifyAccessToken: typeof verifyAccessToken;
    };
    verifyAccessToken = mod.verifyAccessToken;
  } catch {
    // SDK not installed — Phase 4 owns the install. Treat as "disabled"
    // rather than crashing. The console.warn fires once-per-process via
    // the gate below.
    warnSdkMissingOnce();
    return null;
  }

  try {
    const verified = await verifyAccessToken({
      access_token: authToken,
      app_id: process.env.PRIVY_APP_ID as string,
      verification_key: process.env.PRIVY_VERIFICATION_KEY as string,
    });
    const expiresAtIso = new Date(verified.expiration * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
    return {
      privy_user_id: verified.user_id,
      session_id: verified.session_id,
      expires_at: expiresAtIso,
    };
  } catch {
    // Invalid / expired / wrong-issuer token. Library throws
    // InvalidAuthTokenError — we treat all failures uniformly so we never
    // leak which check failed (timing/error-shape side channel).
    return null;
  }
}

let _sdkMissingWarned = false;
function warnSdkMissingOnce(): void {
  if (_sdkMissingWarned) return;
  _sdkMissingWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[murmur][privy] PRIVY_APP_ID is set but @privy-io/node is not installed; " +
      "Privy auth path disabled. Run `npm install @privy-io/node` to enable.",
  );
}
