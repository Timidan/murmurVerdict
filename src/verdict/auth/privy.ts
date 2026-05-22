// ─── Privy access-token verification (V2 §7.1 casual tier) ──────────────────
//
// Verifies a Privy-issued access token via the official @privy-io/node SDK
// and returns a normalized claims object the dispatcher can route on, or
// `null` if Privy auth is disabled / the token is invalid.
//
// SDK shape (verified against @privy-io/node@0.18.0 installed in this
// worktree — see node_modules/@privy-io/node/lib/auth.d.ts and
// node_modules/@privy-io/node/public-api/services/utils/auth.d.ts):
//
//   import { PrivyClient } from "@privy-io/node";
//   const privy = new PrivyClient({
//     appId: process.env.PRIVY_APP_ID,
//     appSecret: process.env.PRIVY_APP_SECRET,
//     jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY,
//   });
//   const claims = await privy.utils().auth().verifyAccessToken(accessToken);
//   // claims => { app_id, issuer, issued_at, expiration, session_id, user_id }
//
// We chose the PrivyClient form (not the standalone `verifyAccessToken`
// function) for two reasons:
//   1) It caches the parsed JWKS / verification key on the client instance
//      so per-request verification doesn't re-parse the SPKI string. The
//      standalone form re-imports the key on every call.
//   2) Phase 4 will need privy.users().get({id_token}) to hydrate email
//      lazily (the access token doesn't carry email — see §"What's NOT in
//      the access token" below). Sharing one client keeps that wiring
//      trivial when we add it.
//
// Why we don't throw on invalid tokens:
//   The dispatcher (auth/dispatcher.ts) needs to fall through to API-key
//   auth when a Privy token isn't present or doesn't verify. Throwing here
//   would force every existing client to route around an exception. `null`
//   lets the dispatcher try the next auth mode cleanly.
//
// Env contract:
//   PRIVY_APP_ID            — required: the Privy application ID.
//   PRIVY_APP_SECRET        — required: the server-side secret. The SDK
//                             constructor demands it even for verify-only
//                             flows because PrivyClient is one object that
//                             also supports user-management API calls.
//   PRIVY_VERIFICATION_KEY  — required: PEM-encoded SPKI public key from
//                             the Privy dashboard (Settings → Advanced).
//                             Baked at deploy time; we never fetch the
//                             JWKS at request time (would re-introduce
//                             a network dependency on every auth call).
//
// What's NOT in the access token:
//   The Privy access token only carries: app_id, issuer, issued_at,
//   expiration, session_id, user_id (the DID). It does NOT carry email
//   or login_method. Those live in the IDENTITY token (separate JWT,
//   verified via privy.users().get({id_token})) or behind an API call.
//   For this scaffold we surface DID + sid + exp only. Phase 4 will
//   wire identity-token verification when the dashboard needs to display
//   the email.
//
// Replay / CSRF posture:
//   - Privy tokens have a short exp (typically 1h). The SDK enforces
//     `exp` for us via jose.jwtVerify under the hood.
//   - The token is a Bearer credential — anyone in possession can present
//     it. CSRF mitigation is the responsibility of the dispatcher's
//     calling context (browser flows must use SameSite cookies; CLI
//     flows present the token directly via Authorization header).
//   - There is NO server-side nonce table for access tokens. If we need
//     replay protection beyond the JWT exp, that lives in Phase 8's
//     EIP-712 nonce design, not here.

import type { PrivyClient as PrivyClientType } from "@privy-io/node";

export interface PrivyClaims {
  /** The Privy user DID, e.g. 'did:privy:xxxxx'. Stable per user. */
  privy_user_id: string;
  /** The session ID. Useful for log correlation. */
  session_id: string;
  /** Token expiration as ISO-8601 (UTC). */
  expires_at: string;
  /**
   * Optional — derived if available. The access token does NOT carry an
   * email; this stays undefined in the scaffold. Phase 4's identity-token
   * verifier (privy.users().get({id_token})) can populate it.
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
 * re-reading process.env. Read at call time (not module load) because
 * dotenv may not have populated process.env when this module first
 * imports.
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

// ─── Lazy singleton ─────────────────────────────────────────────────────────
//
// We construct the PrivyClient on first call rather than at module load,
// for three reasons:
//   1) dotenv-config may not yet have run when this file imports. Reading
//      process.env at module top-level would lock in stale values.
//   2) Tests can rebuild the singleton by clearing the cache (see
//      __resetPrivyClientForTests). Module-load construction can't.
//   3) Dev / smoke runs without Privy creds set must NOT crash on import.
//      A lazy ctor lets the env-gate at the top of verifyPrivyAuth short-
//      circuit before any SDK code touches the missing creds.

let _client: PrivyClientType | null = null;
let _clientCtorError: Error | null = null;
let _sdkMissingWarned = false;

async function getClient(): Promise<PrivyClientType | null> {
  if (_client) return _client;
  if (_clientCtorError) {
    // Surfaced once already; stay quiet until process restart or test reset.
    return null;
  }
  if (!isPrivyEnabled()) return null;

  // Dynamic import keeps the SDK and its hpke / jose / svix deps out of
  // the import graph for deploys that don't enable Privy. A static import
  // would pull them into every entrypoint regardless.
  let PrivyClient: typeof PrivyClientType;
  try {
    const mod = (await import("@privy-io/node")) as {
      PrivyClient: typeof PrivyClientType;
    };
    PrivyClient = mod.PrivyClient;
  } catch (err) {
    warnSdkMissingOnce(err);
    _clientCtorError = err instanceof Error ? err : new Error(String(err));
    return null;
  }

  try {
    _client = new PrivyClient({
      appId: process.env.PRIVY_APP_ID as string,
      appSecret: process.env.PRIVY_APP_SECRET as string,
      jwtVerificationKey: process.env.PRIVY_VERIFICATION_KEY as string,
    });
    return _client;
  } catch (err) {
    // Constructor can throw on malformed verification key (jose's
    // importSPKI bombs on a non-PEM string, for example). Treat as
    // disabled rather than crash the request loop. Warn once so the
    // operator sees it in logs.
    _clientCtorError = err instanceof Error ? err : new Error(String(err));
    // eslint-disable-next-line no-console
    console.warn(
      "[murmur][privy] PrivyClient construction failed; auth path disabled:",
      _clientCtorError.message,
    );
    return null;
  }
}

/**
 * Verify a Privy access token. Returns normalized claims or `null` if
 * Privy auth is disabled or the token did not verify.
 *
 * NOT YET WIRED — the dispatcher imports this but the dispatcher itself
 * is not mounted until Phase 4. See module header for env contract.
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

  const client = await getClient();
  if (!client) return null;

  try {
    const verified = await client.utils().auth().verifyAccessToken(authToken);
    const expiresAtIso = new Date(verified.expiration * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
    return {
      privy_user_id: verified.user_id,
      session_id: verified.session_id,
      expires_at: expiresAtIso,
    };
  } catch {
    // Invalid / expired / wrong-issuer / wrong-audience token. The SDK
    // throws InvalidAuthTokenError — we treat all failures uniformly so we
    // never leak which check failed (timing/error-shape side channel).
    return null;
  }
}

/**
 * Test-only helper: drop the cached client so a subsequent call to
 * verifyPrivyAuth re-reads process.env and re-constructs. Smoke tests
 * use this to flip the disabled/enabled gate without spawning a new
 * process.
 *
 * Marked with __ prefix and not exported from any barrel — production
 * code should never import this.
 */
export function __resetPrivyClientForTests(): void {
  _client = null;
  _clientCtorError = null;
  _sdkMissingWarned = false;
}

function warnSdkMissingOnce(err: unknown): void {
  if (_sdkMissingWarned) return;
  _sdkMissingWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[murmur][privy] PRIVY_APP_ID is set but @privy-io/node could not be loaded; " +
      "Privy auth path disabled. Underlying error:",
    err instanceof Error ? err.message : err,
  );
}
