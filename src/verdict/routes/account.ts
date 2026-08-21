// ─── /v1/account/* router (V2 §7.1 casual tier) ────────────────────────────
//
// Routes:
//   POST   /v1/account/session                          — Privy → account upsert
//   POST   /v1/account/agents                           — create casual agent
//   GET    /v1/account/agents                           — list owned agents
//   POST   /v1/account/agents/:slug/wallet/challenge    — build controller-wallet signature text
//   PATCH  /v1/account/agents/:slug/wallet              — bind Controller Wallet once
//   POST   /v1/account/agents/:slug/wallet/reattest/challenge — build periodic human re-attestation text
//   POST   /v1/account/agents/:slug/wallet/reattest      — refresh Controller Wallet human attestation
//   GET    /v1/account/agents/:slug/runtime-keys        — list runtime-key metadata
//   POST   /v1/account/agents/:slug/runtime-keys        — mint a Gateway runtime key
//   DELETE /v1/account/runtime-keys/:key_id             — revoke runtime key
//   POST   /v1/account/agents/:slug/api-keys            — mint scoped key
//   DELETE /v1/account/api-keys/:key_id                 — rotate (soft delete)
//   PATCH  /v1/account/agents/:slug/destination-address — set/update payout addr
//   POST   /v1/account/events                           — emit account funnel event
//
// Auth model:
//   Every route except /session expects an already-verified casual-tier
//   identity. /session itself accepts a raw Privy Bearer token, runs it
//   through the caller-supplied PrivyAuthVerifier, and creates/updates the account row. The
//   other routes require both Privy auth AND ownership of the targeted
//   agent (account_agents bridge). Account ownership is enforced inside
//   each handler — the router does not assume Phase-4 middleware has
//   already filtered.

import { Router } from "express";
import express from "express";
import type Database from "better-sqlite3";
import { accountSessionRouter } from "./account-session.js";
import { accountAgentsRouter } from "./account-agents.js";
import { accountControllerWalletRouter } from "./account-controller-wallet.js";
import { accountRuntimeKeyRouter } from "./account-runtime-keys.js";
import { accountKillSwitchRouter } from "./account-kill-switch.js";
import { accountActivityRouter } from "./account-activity.js";
import { accountApiKeyRouter } from "./account-api-keys.js";
import { accountDestinationRouter } from "./account-destination.js";
import { accountFunnelEventsRouter } from "./account-funnel-events.js";
import { accountDeactivateRouter } from "./account-deactivate.js";
import { accountWebhooksRouter } from "./account-webhooks.js";
import { assertAccountActive } from "../auth/account-lifecycle.js";
import { accountRouteLimiters } from "../account-rate-limit-surface.js";
import type { AccountAgentIdAdapter } from "../account-agent-surface.js";
import type {
  AccountIdAdapter,
  ControllerWalletReattestationIdAdapter,
} from "../auth/accounts.js";
import { bindRequireAccount, type AccountAuthVerifier } from "../account-route-auth.js";
import type { ControllerWalletAuthorizationNonceAdapter } from "../controller-wallet-authorization.js";
import type { UsageEventIdAdapter } from "../usage-event.js";

export interface AccountRouterDeps {
  db: Database.Database;
  accountAuth?: AccountAuthVerifier;
  newAccountId?: AccountIdAdapter;
  newAgentId?: AccountAgentIdAdapter;
  newApiKeyId?: () => string;
  newApiKeySecret?: () => string;
  newAuthorizationNonce?: ControllerWalletAuthorizationNonceAdapter;
  newReattestationId?: ControllerWalletReattestationIdAdapter;
  newRuntimeKeyId?: () => string;
  newRuntimeKeySecret?: () => string;
  newUsageEventId?: UsageEventIdAdapter;
  /**
   * What this deployment can grant for ONE call inside the delivery budget.
   * Surfaced on the provider-terms route so an owner whose business ceiling
   * exceeds it is told, rather than silently clamped.
   */
  deliverableCap?: number;
  /**
   * Murmur's cut of a sale, in basis points, as this deployment is configured.
   * Passed from the parsed daemon config rather than re-read from the ambient
   * process, so a daemon started with an injected env behaves the same way.
   * `null` states outright that none is set; `undefined` leaves the surface to
   * read MURMUR_PROTOCOL_FEE_BPS itself (direct/test construction).
   */
  protocolFeeBps?: number | null;
  /**
   * FHENIX_REVEAL_WORKER_GRACE_SEC as this deployment is configured, threaded
   * from the parsed daemon config for the reveals duty list. `null`/undefined
   * means no fallback reveal worker runs here, and the surface then reports no
   * deadline rather than printing the loader's default as if it were policy.
   */
  revealGraceSeconds?: number | null;
  /** HTTP route operation clock shared across account route Adapters. */
  now: () => Date;
  /**
   * Optional cooldown override for tests. Real deploys leave this
   * unset and use the default from auth/accounts.ts (24h).
   */
  destinationCooldownMs?: number;
}

export function createAccountRouter(deps: AccountRouterDeps): Router {
  const router = Router();
  const json = express.json({ limit: "32kb" });
  const {
    accountAuth,
    db,
    destinationCooldownMs,
    newAccountId,
    newAgentId,
    newApiKeyId,
    newApiKeySecret,
    newAuthorizationNonce,
    newReattestationId,
    newRuntimeKeyId,
    newRuntimeKeySecret,
    newUsageEventId,
    now,
  } = deps;

  const {
    sessionLimiter,
    createAgentLimiter,
    listAgentsLimiter,
    mintKeyLimiter,
    rotateKeyLimiter,
    destAddrLimiter,
    funnelEventLimiter,
  } = accountRouteLimiters();

  // Bind Account Route Auth ONCE for this router: the db handle, Privy
  // verifier, Account ID Adapter, and account-resolution clock are captured
  // here so every sub-router handler depends only on the request. This is the
  // shared router-construction closure — the Account ID Adapter lives here (it
  // only ever feeds account creation via auth), while the remaining ID
  // Adapters stay threaded to their owning sub-routers so each Records module
  // keeps its own production default intact.
  const requireAccount = bindRequireAccount(db, accountAuth, {
    newAccountId,
    now,
  });

  // ── The deactivation gate, applied ONCE at dispatch ──────────────────────
  //
  // A closed account (accounts.deactivated_at, migration 073) is refused
  // everywhere under /v1/account/*. Enforcing it here rather than inside each
  // handler means a route added tomorrow inherits the refusal by construction
  // — the failure mode of the per-route habit is a route someone forgot, and
  // that route is then the one hole in a terminal state.
  //
  // It reads deactivated_at and NOTHING ELSE. In particular it does not read
  // the kill switch: those two columns are separate precisely so that
  // releasing the switch cannot reopen a closed account.
  //
  // Two deliberate exemptions, both wired with the RAW `requireAccount`:
  //
  //   · the session router — GET /v1/account/session is how the dashboard
  //     learns it should render the closed-account screen. Its POST sibling
  //     is refused, and the dashboard falls back to the GET on that 403.
  //   · the deactivate router — a retried close must report
  //     already_deactivated, not 403.
  const requireActiveAccount: typeof requireAccount = async (req, opts) => {
    const resolved = await requireAccount(req, opts);
    assertAccountActive(db, resolved.account_id);
    return resolved;
  };

  router.use(accountSessionRouter({
    // GET reads the terminal state and stays open; POST touches last_seen_at
    // and is a write like any other, so it is gated.
    requireAccount,
    requireActiveAccount,
    sessionLimiter,
    json,
    db,
  }));

  router.use(accountDeactivateRouter({
    requireAccount,
    db,
    json,
    limiter: rotateKeyLimiter,
    now,
  }));

  router.use(accountAgentsRouter({
    requireAccount: requireActiveAccount,
    db,
    createAgentLimiter,
    json,
    listAgentsLimiter,
    newAgentId,
    deliverableCap: deps.deliverableCap,
    protocolFeeBps: deps.protocolFeeBps,
    revealGraceSeconds: deps.revealGraceSeconds,
    now,
  }));

  router.use(accountWebhooksRouter({
    requireAccount: requireActiveAccount,
    db,
    listLimiter: listAgentsLimiter,
    writeLimiter: rotateKeyLimiter,
  }));

  router.use(accountControllerWalletRouter({
    requireAccount: requireActiveAccount,
    db,
    destAddrLimiter,
    json,
    newAuthorizationNonce,
    newReattestationId,
    now,
  }));

  router.use(accountRuntimeKeyRouter({
    requireAccount: requireActiveAccount,
    db,
    json,
    listAgentsLimiter,
    mintKeyLimiter,
    newAuthorizationNonce,
    newRuntimeKeyId,
    newRuntimeKeySecret,
    now,
    rotateKeyLimiter,
  }));

  router.use(accountKillSwitchRouter({
    requireAccount: requireActiveAccount,
    db,
    json,
    limiter: rotateKeyLimiter,
    now,
  }));

  router.use(accountActivityRouter({
    requireAccount: requireActiveAccount,
    db,
    limiter: listAgentsLimiter,
  }));

  router.use(accountApiKeyRouter({
    requireAccount: requireActiveAccount,
    db,
    json,
    listAgentsLimiter,
    mintKeyLimiter,
    newApiKeyId,
    newApiKeySecret,
    now,
    rotateKeyLimiter,
  }));

  router.use(accountDestinationRouter({
    requireAccount: requireActiveAccount,
    db,
    destinationCooldownMs,
    destAddrLimiter,
    json,
    newUsageEventId,
    now,
  }));

  router.use(accountFunnelEventsRouter({
    requireAccount: requireActiveAccount,
    db,
    funnelEventLimiter,
    json,
    newUsageEventId,
    now,
  }));

  return router;
}

/** Singleton-style export — Phase 4 prefers this for ergonomic mounting. */
export const accountRouter = (deps: AccountRouterDeps): Router =>
  createAccountRouter(deps);
