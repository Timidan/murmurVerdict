import type { Request } from "express";
import type Database from "better-sqlite3";
import {
  backfillAccountProfile,
  resolveAccountForClaims,
  type AccountIdAdapter,
} from "./auth/accounts.js";
import {
  verifyPrivyBearer,
  type PrivyAuthVerifier,
  type PrivyClaims,
} from "./auth/privy.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export type { PrivyAuthVerifier as AccountAuthVerifier } from "./auth/privy.js";

export interface ResolvedAccount {
  claims: PrivyClaims;
  account_id: string;
  created: boolean;
}

export interface AccountRouteAuthClock {
  now: () => Date;
}

export interface AccountRouteAuthAdapters {
  newAccountId?: AccountIdAdapter;
}

/** Resolves the Privy Bearer to an account row, or null. Prefer requireAccount for the standard auth failure. */
export async function resolveAccount(
  req: Request,
  db: Database.Database,
  accountAuth: PrivyAuthVerifier | undefined,
  opts: AccountRouteAuthClock & AccountRouteAuthAdapters,
): Promise<ResolvedAccount | null> {
  const claims = await verifyPrivyBearer(req, accountAuth);
  if (!claims) return null;
  const { account_id, created } = resolveAccountForClaims(db, claims, {
    mode: "create_or_touch",
    resolvedAt: opts.now(),
    newAccountId: opts.newAccountId,
  });
  // Backfill profile only on creation, so wallet-only users (no email) don't trigger a Privy lookup per request.
  // hydrateProfile never throws.
  if (created && accountAuth?.isEnabled()) {
    const profile = await accountAuth.hydrateProfile(claims.privy_user_id);
    if (profile.email || profile.primary_login_method) {
      backfillAccountProfile(db, account_id, profile);
      return { claims: { ...claims, ...profile }, account_id, created };
    }
  }
  return { claims, account_id, created };
}

export async function requireAccount(
  req: Request,
  db: Database.Database,
  accountAuth: PrivyAuthVerifier | undefined,
  opts: { message?: string } & AccountRouteAuthClock & AccountRouteAuthAdapters,
): Promise<ResolvedAccount> {
  const resolved = await resolveAccount(req, db, accountAuth, {
    newAccountId: opts.newAccountId,
    now: opts.now,
  });
  if (resolved) return resolved;
  throw accountAuthRequiredError(opts.message);
}

/** Owner-facing auth with db, verifier, id adapter and clock bound at router construction. */
export type RequireAccount = (
  req: Request,
  opts?: { message?: string },
) => Promise<ResolvedAccount>;

/** Binds requireAccount once per router so handlers pass only the request. */
export function bindRequireAccount(
  db: Database.Database,
  accountAuth: PrivyAuthVerifier | undefined,
  opts: AccountRouteAuthClock & AccountRouteAuthAdapters,
): RequireAccount {
  return (req, callOpts) =>
    requireAccount(req, db, accountAuth, {
      ...(callOpts?.message !== undefined ? { message: callOpts.message } : {}),
      newAccountId: opts.newAccountId,
      now: opts.now,
    });
}

export function accountAuthRequiredError(message = "auth required"): VerdictError {
  return new VerdictError(
    message,
    ERROR_CODES.agent_not_authorized,
    401,
  );
}
