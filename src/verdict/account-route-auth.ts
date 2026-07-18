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

/**
 * Resolve the Privy Bearer token from a request into a Murmur account row.
 * Returns null if no Bearer is present or verification fails. Prefer
 * requireAccount for account route Modules that should share the standard
 * owner-facing auth failure.
 */
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
  // Populate email + primary_login_method exactly once, on account CREATION.
  // Gating on `created` (not "email is null") ensures wallet-only users — who
  // legitimately have no email — don't re-trigger a Privy lookup on every
  // request. hydrateProfile never throws, so this stays a pure enrichment.
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

/**
 * Request-only owner-facing auth, with the db handle, Privy verifier, Account
 * ID Adapter, and account-resolution clock already bound at router
 * construction. Account sub-router handlers call this with just the request
 * (plus an optional failure message) instead of rethreading the auth quad.
 */
export type RequireAccount = (
  req: Request,
  opts?: { message?: string },
) => Promise<ResolvedAccount>;

/**
 * Bind Account Route Auth once for a router: capture db + verifier + Account
 * ID Adapter + clock so downstream handlers depend only on the request. See
 * createAccountRouter — the returned closure replaces the 4-arg requireAccount
 * call at every account sub-router handler.
 */
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
