import type { Request } from "express";
import type Database from "better-sqlite3";

import { resolveAccountForClaims } from "./account-ownership.js";
import { verifyApiKey } from "./api-keys.js";
import { verifyPrivyBearer, type PrivyAuthVerifier } from "./privy.js";

export interface WebhookAuthIdentity {
  account_id: string;
  auth_mode: "privy" | "api_key";
}

/**
 * Account-only auth for POST /v1/webhooks. Ignores slug headers so a bearer cannot probe
 * which slugs exist; the handler turns unknown and unowned slugs into one 403.
 * Kept apart from the Auth Dispatcher, whose 404/403 split would leak that.
 */
/** Closed or kill-switched accounts get the same null (→ 401) as no credentials, on both tiers. */
function accountLockedOut(db: Database.Database, accountId: string): boolean {
  const row = db
    .prepare(
      "SELECT deactivated_at, agent_credentials_disabled_at FROM accounts WHERE account_id = ?",
    )
    .get(accountId) as
    | { deactivated_at: string | null; agent_credentials_disabled_at: string | null }
    | undefined;
  return Boolean(row?.deactivated_at || row?.agent_credentials_disabled_at);
}

export async function authenticateWebhookAccount(
  req: Request,
  deps: { db: Database.Database; privyAuth?: PrivyAuthVerifier },
): Promise<WebhookAuthIdentity | null> {
  const claims = await verifyPrivyBearer(req, deps.privyAuth);
  if (claims) {
    // Read-only: no account is created here. Fall through to the api-key tier.
    const { account_id } = resolveAccountForClaims(deps.db, claims, { mode: "read" });
    if (account_id) {
      if (accountLockedOut(deps.db, account_id)) return null;
      return { account_id, auth_mode: "privy" };
    }
  }

  const apiKey = req.header("X-Murmur-Api-Key");
  if (apiKey) {
    const accountKey = verifyApiKey(deps.db, apiKey);
    if (accountKey) {
      if (accountLockedOut(deps.db, accountKey.account_id)) return null;
      return { account_id: accountKey.account_id, auth_mode: "api_key" };
    }
  }

  return null;
}
