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
//     // PRIVY_VERIFICATION_KEY is OMITTED — see "JWKS by default" below.
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
// JWKS by default:
//   When `jwtVerificationKey` is undefined, PrivyClient's constructor calls
//   `createPrivyAppJWKS` (node_modules/@privy-io/node/lib/auth.js) which
//   creates a `jose` remote-JWKS getter pointed at
//   `<apiUrl>/v1/apps/<appId>/jwks.json` with `cacheMaxAge: 60 min` and
//   `cooldownDuration: 10 min`. The cache age caps how long a successful
//   fetch is reused; the cooldown throttles refetches when a presented
//   token references an unknown `kid` (so a flood of unknown-kid tokens
//   can't hammer Privy with refetches). That means we no longer paste a
//   PEM at deploy time, and key rotations by Privy are picked up
//   automatically within one cache window. The verifier function returned
//   is plugged into the same `jose.jwtVerify` call the static-PEM path
//   uses, so verification semantics are identical. If Privy is
//   unreachable AND the cache is cold, verify throws → null → 401 (fail
//   closed — desired for an auth surface).
//
// Why we don't throw on invalid tokens:
//   The dispatcher (auth/dispatcher.ts) needs to fall through to API-key
//   auth when a Privy token isn't present or doesn't verify. Throwing here
//   would force every existing client to route around an exception. `null`
//   lets the dispatcher try the next auth mode cleanly.
//
// Config contract:
//   PRIVY_APP_ID            — required: the Privy application ID.
//   PRIVY_APP_SECRET        — required: the server-side secret. The SDK
//                             constructor demands it even for verify-only
//                             flows because PrivyClient is one object that
//                             also supports user-management API calls.
//   PRIVY_VERIFICATION_KEY  — optional: PEM-encoded SPKI public key from
//                             the Privy dashboard (Configuration → App
//                             settings → JWT / Token verification). When
//                             set, pins the verifier to this exact key and
//                             skips the JWKS endpoint — useful for tying
//                             a deploy to a specific Privy key against
//                             upstream-compromise scenarios. When unset
//                             (recommended for ordinary deploys), the SDK
//                             fetches + caches the JWKS automatically.
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

export interface PrivyAuthConfig {
  appId: string | null;
  appSecret: string | null;
  /**
   * Optional PEM-pinned override. `null` (default) leaves the SDK to fetch
   * + cache the JWKS endpoint. Set only when a deploy wants to lock
   * verification to a specific key (defense against Privy infra
   * compromise, air-gapped audits, etc.).
   */
  jwtVerificationKey: string | null;
}

export interface PrivyAuthVerifier {
  isEnabled(): boolean;
  verify(authToken: string): Promise<PrivyClaims | null>;
  /**
   * Best-effort profile hydration for account CREATION only. Looks up the
   * Privy user's linked accounts to derive an email + primary login method
   * the access token never carries. NEVER throws — returns `{}` when Privy
   * is disabled, the client can't be built, or the lookup fails, so callers
   * can treat it as a pure enrichment with no failure mode.
   */
  hydrateProfile(userId: string): Promise<{ email?: string; primary_login_method?: string }>;
}

/**
 * Narrow structural request shape so this module stays uncoupled from
 * express — `verifyPrivyBearer` only needs to read headers.
 */
export interface PrivyBearerRequest {
  header(name: string): string | undefined;
}

/**
 * Shared `Authorization: Bearer <privy>` extraction + verification, used by
 * the dispatcher and the account / webhook route auth paths. Returns the
 * verified claims, or `null` when there is no verifier, no/non-Bearer
 * header, or the token does not verify — every case those callers currently
 * treat as fall-through.
 *
 * Contract preservation: this MUST NOT add a try/catch around `verify` and
 * MUST NOT add an empty-token guard. The three current call sites do
 * neither — a verifier exception propagates and an empty token is passed
 * straight to `verify` (which returns null) — and this helper keeps that
 * exact behavior so it is a pure extraction, not a behavior change.
 */
export async function verifyPrivyBearer(
  req: PrivyBearerRequest,
  verifier: PrivyAuthVerifier | undefined,
): Promise<PrivyClaims | null> {
  const authzHeader = req.header("Authorization") ?? req.header("authorization");
  if (verifier && authzHeader && /^Bearer\s+/i.test(authzHeader)) {
    const token = authzHeader.replace(/^Bearer\s+/i, "").trim();
    return verifier.verify(token);
  }
  return null;
}

export class PrivyAuthConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "PrivyAuthConfigError";
    this.key = key;
  }
}

export function loadPrivyAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): PrivyAuthConfig {
  const config = {
    appId: nonEmpty(env.PRIVY_APP_ID),
    appSecret: nonEmpty(env.PRIVY_APP_SECRET),
    jwtVerificationKey: nonEmpty(env.PRIVY_VERIFICATION_KEY),
  };

  // Pair-required: APP_ID + APP_SECRET must be set together. If either is
  // set without the other, the deploy is misconfigured and we fail loudly
  // instead of silently disabling Privy. VERIFICATION_KEY is an optional
  // override and never independently triggers the requirement (the SDK
  // falls back to JWKS auto-fetch when it's null).
  const idOrSecretSet = Boolean(config.appId || config.appSecret);
  if (idOrSecretSet) {
    assertPrivyConfigPart(config.appId, "PRIVY_APP_ID");
    assertPrivyConfigPart(config.appSecret, "PRIVY_APP_SECRET");
  } else if (config.jwtVerificationKey) {
    // VERIFICATION_KEY without APP_ID/APP_SECRET is nonsense — the key
    // can't verify anything if no client is constructed. Surface it.
    assertPrivyConfigPart(config.appId, "PRIVY_APP_ID");
  }

  return config;
}

export function createPrivyAuthVerifier(
  config: PrivyAuthConfig,
): PrivyAuthVerifier {
  let client: PrivyClientType | null = null;
  let clientCtorError: Error | null = null;
  let sdkMissingWarned = false;

  const enabled = (): boolean => privyConfigEnabled(config);

  const getClient = async (): Promise<PrivyClientType | null> => {
    if (client) return client;
    if (clientCtorError) {
      // Surfaced once already; stay quiet until process restart or test reset.
      return null;
    }
    if (!enabled()) return null;

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
      if (!sdkMissingWarned) {
        sdkMissingWarned = true;
        warnSdkMissing(err);
      }
      clientCtorError = err instanceof Error ? err : new Error(String(err));
      return null;
    }

    try {
      // Only forward `jwtVerificationKey` when it's set. Passing `undefined`
      // (NOT empty string) lets PrivyClient's internal `createPrivyAppJWKS`
      // route to the remote JWKS endpoint with default 60-min cache.
      const clientOpts: {
        appId: string;
        appSecret: string;
        jwtVerificationKey?: string;
      } = {
        appId: config.appId as string,
        appSecret: config.appSecret as string,
      };
      if (config.jwtVerificationKey) {
        clientOpts.jwtVerificationKey = config.jwtVerificationKey;
      }
      client = new PrivyClient(clientOpts);
      return client;
    } catch (err) {
      // Constructor can throw on malformed verification key (jose's
      // importSPKI bombs on a non-PEM string, for example). Treat as
      // disabled rather than crash the request loop. Warn once so the
      // operator sees it in logs.
      clientCtorError = err instanceof Error ? err : new Error(String(err));
      // eslint-disable-next-line no-console
      console.warn(
        "[murmur][privy] PrivyClient construction failed; auth path disabled:",
        clientCtorError.message,
      );
      return null;
    }
  };

  return {
    isEnabled: enabled,
    async verify(authToken: string): Promise<PrivyClaims | null> {
      if (!enabled()) {
        return null;
      }
      if (typeof authToken !== "string" || authToken.length < 10) {
        return null;
      }

      const verifiedClient = await getClient();
      if (!verifiedClient) return null;

      try {
        const verified = await verifiedClient.utils().auth().verifyAccessToken(authToken);
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
    },
    async hydrateProfile(userId) {
      if (!enabled()) return {};
      const c = await getClient();
      if (!c) return {};
      try {
        const user = await c.users()._get(userId);
        const accounts = user.linked_accounts ?? [];
        if (accounts.length === 0) return {};
        const primary = [...accounts].sort(
          (a, b) => (a.first_verified_at ?? a.verified_at) - (b.first_verified_at ?? b.verified_at),
        )[0];
        const emailAcct = accounts.find((a) => a.type === "email");
        const email =
          (emailAcct && "address" in emailAcct ? emailAcct.address : undefined) ??
          accounts.map((a) => ("email" in a ? (a as { email?: string }).email : null)).find(Boolean) ??
          undefined;
        const out: { email?: string; primary_login_method?: string } = {};
        if (email) out.email = email;
        if (primary?.type) out.primary_login_method = primary.type;
        return out;
      } catch {
        return {};
      }
    },
  };
}

function assertPrivyConfigPart(
  value: string | null,
  key: string,
): asserts value is string {
  if (value) return;
  throw new PrivyAuthConfigError(
    key,
    "is required when Privy auth is configured",
  );
}

function privyConfigEnabled(config: PrivyAuthConfig): boolean {
  // JWKS-by-default: VERIFICATION_KEY is optional. Privy is "enabled" as
  // soon as APP_ID + APP_SECRET are both set (loadPrivyAuthConfig already
  // enforced pair-required). When VERIFICATION_KEY is null the SDK uses
  // the remote JWKS endpoint; when set it pins to that PEM.
  return Boolean(config.appId && config.appSecret);
}

function nonEmpty(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function warnSdkMissing(err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    "[murmur][privy] PRIVY_APP_ID is set but @privy-io/node could not be loaded; " +
      "Privy auth path disabled. Underlying error:",
    err instanceof Error ? err.message : err,
  );
}
