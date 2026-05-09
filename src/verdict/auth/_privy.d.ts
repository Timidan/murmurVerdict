// Local ambient declaration for @privy-io/node — Phase-7 scaffold only.
//
// Why this file exists:
//   The brief deliberately defers `npm install @privy-io/node` to the
//   Phase-4 integration step (the worktree's node_modules is a SYMLINK to a
//   sibling tree, so a real install would mutate shared state across
//   worktrees). Until that install lands, TypeScript still needs to
//   resolve `import { ... } from '@privy-io/node'` so the build stays
//   green.
//
// Why a stub and not the real types:
//   - We only need a tiny surface area: the verifyAccessToken() function
//     and its input/output shapes. The real package's surface is much
//     larger (wallets, signing, transaction submission) — none of which
//     this scaffold uses.
//   - Re-declaring the full surface would create a maintenance burden:
//     when @privy-io/node bumps, this file would lie. Keeping it minimal
//     means Phase 4 can delete this file once `npm install` runs and the
//     real types take over without any code changes elsewhere.
//
// Source of truth for the shape below:
//   https://github.com/privy-io/node-sdk/blob/main/src/lib/auth.ts
//
// IMPORTANT: when Phase 4 runs `npm install @privy-io/node`, DELETE THIS
// FILE. The real types ship with the package.

declare module "@privy-io/node" {
  export interface VerifyAccessTokenInput {
    access_token: string;
    app_id: string;
    /**
     * SPKI public key (PEM string), a CryptoKey instance, or a JWTVerifyGetKey
     * function (typically from `createRemoteJWKSet` for JWKS-based verification).
     * The scaffold uses the SPKI string form via PRIVY_VERIFICATION_KEY.
     */
    verification_key: unknown;
  }

  export interface VerifyAccessTokenResponse {
    /** The Privy app ID for which the token was issued. */
    app_id: string;
    /** The issuer of the token (always 'privy.io'). */
    issuer: string;
    /** Issued-at unix timestamp (seconds). */
    issued_at: number;
    /** Expiration unix timestamp (seconds). */
    expiration: number;
    /** The session ID that minted the token. */
    session_id: string;
    /** The Privy user DID, e.g. 'did:privy:xxxxx'. */
    user_id: string;
  }

  export function verifyAccessToken(
    input: VerifyAccessTokenInput,
  ): Promise<VerifyAccessTokenResponse>;
}
