import type { Request } from "express";
import type Database from "better-sqlite3";
import {
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

export function accountAuthRequiredError(message = "auth required"): VerdictError {
  return new VerdictError(
    message,
    ERROR_CODES.agent_not_authorized,
    401,
  );
}
