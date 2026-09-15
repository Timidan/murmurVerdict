// ─── Privy access-token verification ────────────────────────────────────────
// Returns normalized claims, or null when Privy is off, the token is bad, or Privy is unreachable
// with a cold key cache. Null, not a throw: the dispatcher falls through to API keys. Fails closed.
// No PRIVY_VERIFICATION_KEY uses Privy's remote JWKS; a PEM pins one key. APP_SECRET is always required.
// The access token has no email or login_method. CSRF is the caller's job (SameSite cookie or header).

import type { PrivyClient as PrivyClientType } from "@privy-io/node";

export interface PrivyClaims {
  /** The Privy user DID, e.g. 'did:privy:xxxxx'. Stable per user. */
  privy_user_id: string;
  session_id: string;
  /** Token expiration as ISO-8601 (UTC). */
  expires_at: string;
  /** Not in the access token; undefined from verify(). */
  email?: string;
  /** Not in the access token; undefined from verify(). */
  primary_login_method?: string;
}

export interface PrivyAuthConfig {
  appId: string | null;
  appSecret: string | null;
  /** Optional PEM pin. Null lets the SDK fetch and cache the JWKS. */
  jwtVerificationKey: string | null;
}

export interface PrivyAuthVerifier {
  isEnabled(): boolean;
  verify(authToken: string): Promise<PrivyClaims | null>;
  /** Best-effort email + login method for account creation. Never throws; `{}` on any failure. */
  hydrateProfile(userId: string): Promise<{ email?: string; primary_login_method?: string }>;
}

/** Minimal request shape so this module does not depend on express. */
export interface PrivyBearerRequest {
  header(name: string): string | undefined;
}

/**
 * Verify `Authorization: Bearer <privy>`. Null when there is no verifier, no Bearer header,
 * or the token fails. Verifier errors propagate; empty tokens go to `verify` (which returns null).
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

  // APP_ID and APP_SECRET must be set together; one without the other throws.
  const idOrSecretSet = Boolean(config.appId || config.appSecret);
  if (idOrSecretSet) {
    assertPrivyConfigPart(config.appId, "PRIVY_APP_ID");
    assertPrivyConfigPart(config.appSecret, "PRIVY_APP_SECRET");
  } else if (config.jwtVerificationKey) {
    // VERIFICATION_KEY without APP_ID/APP_SECRET can verify nothing.
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

    // Dynamic import keeps the SDK out of deploys that don't enable Privy.
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
      // Omit jwtVerificationKey (never "") so the SDK uses the remote JWKS.
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
      // A malformed verification key throws here: treat as disabled and warn once.
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
        // Uniform null for every failure, so which check failed never leaks.
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
  // Enabled once APP_ID + APP_SECRET are set; VERIFICATION_KEY is optional.
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
