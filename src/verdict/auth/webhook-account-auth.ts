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
 * FOLLOW-UP 1 review fix — account-only auth Module for POST /v1/webhooks.
 *
 * The Auth Dispatcher resolves `X-Murmur-Agent-Slug` at auth time and
 * returns distinguishable 404 (unknown_agent) vs 403
 * (agent_not_owned_by_account) outcomes. That split lets a holder of any
 * valid Privy bearer probe whether a target slug exists. The webhook
 * route doesn't need an auth-time agent binding — it carries
 * `body.agent_slug` and enforces ownership in the handler. So we
 * authenticate the ACCOUNT here, ignore every slug header, and let
 * `registerWebhookSubscription` collapse unknown / unowned slugs into a
 * single uniform 403.
 *
 * This is deliberately a SEPARATE Module from the Auth Dispatcher: its
 * read-only, uniform-403 anti-enumeration behavior differs from the
 * dispatcher's slug-probing split and must not be folded in. It accepts a
 * `PrivyAuthVerifier` Adapter so route wiring supplies the real verifier
 * and the route-auth smoke can drive every branch with a fake verifier
 * (no minted Privy token required).
 */
export async function authenticateWebhookAccount(
  req: Request,
  deps: { db: Database.Database; privyAuth?: PrivyAuthVerifier },
): Promise<WebhookAuthIdentity | null> {
  const claims = await verifyPrivyBearer(req, deps.privyAuth);
  if (claims) {
    // READ-only: a verified bearer with no Murmur account is NOT created
    // here — the caller must complete /v1/account/session first. Fall
    // through to api-key tier rather than 401 so a client sending both
    // creds still succeeds.
    const { account_id } = resolveAccountForClaims(deps.db, claims, { mode: "read" });
    if (account_id) {
      return { account_id, auth_mode: "privy" };
    }
  }

  const apiKey = req.header("X-Murmur-Api-Key");
  if (apiKey) {
    const accountKey = verifyApiKey(deps.db, apiKey);
    if (accountKey) {
      return { account_id: accountKey.account_id, auth_mode: "api_key" };
    }
  }

  return null;
}
