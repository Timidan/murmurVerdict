import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import {
  type AccountAgentIdAdapter,
  createAccountAgentResponse,
  listAccountAgentsResponse,
  sendAccountAgentJsonResponse,
} from "../account-agent-surface.js";
import type { RequireAccount } from "../account-route-auth.js";
import { asyncHandler } from "./async-handler.js";
import {
  clearProviderTerms,
  readProviderTerms,
  setProviderTerms,
} from "../provider-terms-surface.js";
import { readProviderEarnings } from "../provider-earnings-surface.js";
import { readProviderPayouts } from "../provider-payout-journal.js";
import { readAccountAgentReveals } from "../account-agent-reveals-surface.js";
import {
  retireAccountAgent,
  unretireAccountAgent,
  updateAccountAgentProfile,
} from "../account-agent-lifecycle-surface.js";

export interface AccountAgentsRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  createAgentLimiter: RequestHandler;
  listAgentsLimiter: RequestHandler;
  json: RequestHandler;
  newAgentId?: AccountAgentIdAdapter;
  /**
   * FHENIX_REVEAL_WORKER_GRACE_SEC as configured on this deployment, for the
   * reveals duty list. `null` when no fallback reveal worker runs here, which
   * the surface reports as "no deadline" rather than inventing one.
   */
  revealGraceSeconds?: number | null;
  /**
   * What this deployment can grant for one call inside the delivery budget.
   * Reported back to owners so a business ceiling above it is visibly clamped
   * rather than silently ignored.
   */
  deliverableCap?: number;
  /**
   * Murmur's cut, in basis points. Left undefined so the terms surface reads
   * MURMUR_PROTOCOL_FEE_BPS itself; passed explicitly only by tests.
   */
  protocolFeeBps?: number | null;
  now: () => Date;
}

export function accountAgentsRouter(deps: AccountAgentsRouterDeps): Router {
  const router = Router();
  const {
    requireAccount,
    db,
    createAgentLimiter,
    listAgentsLimiter,
    json,
    newAgentId,
    deliverableCap,
    protocolFeeBps,
    now,
  } = deps;
  const revealGraceSeconds = deps.revealGraceSeconds ?? null;

  /** Path slug, read the same defensive way every handler in this file does. */
  const pathSlug = (req: Parameters<RequireAccount>[0]): string =>
    String((req as unknown as { params: { slug?: string } }).params.slug ?? "");

  // POST /v1/account/agents - create a casual-tier agent under this account.
  // Body: { display_slug, display_name, bio? }
  router.post(
    "/v1/account/agents",
    createAgentLimiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountAgentJsonResponse(res, createAccountAgentResponse({
        db,
        accountId: resolved.account_id,
        body: req.body,
        newAgentId,
        operationInstant: now(),
      }));
    }),
  );

  // GET /v1/account/agents - list agents owned by this account.
  //
  // Surfaces destination address state so the settings UI can derive the
  // 24h cooldown countdown without an extra round-trip. Reads the columns
  // directly because the public AgentRow shape does not expose payout data.
  router.get(
    "/v1/account/agents",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      sendAccountAgentJsonResponse(res, listAccountAgentsResponse({
        db,
        accountId: resolved.account_id,
        servedAt: now(),
      }));
    }),
  );

  // ── Provider terms: the owner prices their own signal ────────────────────
  //
  // Changing terms affects calls sealed FROM NOW ON. Calls already sealed keep
  // the snapshot they were sold under, so a reprice can never alter what a
  // subscriber already bought into.
  const termsDeps = (req: Parameters<RequireAccount>[0], accountId: string) => ({
    db,
    accountId,
    slug: String((req as unknown as { params: { slug?: string } }).params.slug ?? ""),
    deliverableCap,
    protocolFeeBps,
    now,
  });

  router.get(
    "/v1/account/agents/:slug/provider-terms",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = readProviderTerms(termsDeps(req, resolved.account_id));
      res.status(out.status).json(out.body);
    }),
  );

  router.put(
    "/v1/account/agents/:slug/provider-terms",
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = setProviderTerms({
        ...termsDeps(req, resolved.account_id),
        body: req.body,
      });
      res.status(out.status).json(out.body);
    }),
  );

  // ── Earnings: what this agent's sales have accrued to its owner ──────────
  //
  // Same ownership gate as provider-terms — an agent's revenue is nobody
  // else's business. Read-only and accrual-only: nothing here has been paid
  // out, which is why the totals are named lifetime_accrued_*.
  router.get(
    "/v1/account/agents/:slug/earnings",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const query = (req as unknown as { query: Record<string, unknown> }).query;
      const out = readProviderEarnings({
        db,
        accountId: resolved.account_id,
        slug: String(
          (req as unknown as { params: { slug?: string } }).params.slug ?? "",
        ),
        limit: numeric(query.limit),
        offset: numeric(query.offset),
      });
      res.status(out.status).json(out.body);
    }),
  );

  // ── Payouts: what murmur has actually sent this agent's owner ────────────
  //
  // The other half of the earnings page. Same ownership gate; read-only for
  // the owner, because the entries are written by the operator through
  // POST /v1/admin/payouts and the journal is append-only.
  router.get(
    "/v1/account/agents/:slug/payouts",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const query = (req as unknown as { query: Record<string, unknown> }).query;
      const out = readProviderPayouts({
        db,
        accountId: resolved.account_id,
        slug: pathSlug(req),
        limit: numeric(query.limit),
        offset: numeric(query.offset),
      });
      res.status(out.status).json(out.body);
    }),
  );

  // ── Reveals: the duty list, with the deadline the worker actually uses ───
  router.get(
    "/v1/account/agents/:slug/reveals",
    listAgentsLimiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const query = (req as unknown as { query: Record<string, unknown> }).query;
      const out = readAccountAgentReveals({
        db,
        accountId: resolved.account_id,
        slug: pathSlug(req),
        revealGraceSeconds,
        limit: numeric(query.limit),
        offset: numeric(query.offset),
      });
      res.status(out.status).json(out.body);
    }),
  );

  // ── Profile: the two fields an owner may change. The slug is not one. ────
  router.patch(
    "/v1/account/agents/:slug/profile",
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = updateAccountAgentProfile({
        db,
        accountId: resolved.account_id,
        slug: pathSlug(req),
        body: req.body,
      });
      res.status(out.status).json(out.body);
    }),
  );

  // ── Retirement: stop taking new calls. Everything else is untouched. ─────
  router.post(
    "/v1/account/agents/:slug/retire",
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = retireAccountAgent({
        db,
        accountId: resolved.account_id,
        slug: pathSlug(req),
        now,
      });
      res.status(out.status).json(out.body);
    }),
  );

  router.post(
    "/v1/account/agents/:slug/unretire",
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = unretireAccountAgent({
        db,
        accountId: resolved.account_id,
        slug: pathSlug(req),
        now,
      });
      res.status(out.status).json(out.body);
    }),
  );

  router.delete(
    "/v1/account/agents/:slug/provider-terms",
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const out = clearProviderTerms(termsDeps(req, resolved.account_id));
      res.status(out.status).json(out.body);
    }),
  );

  return router;
}

/** Query-string integer, or undefined when absent/unparseable (the surface clamps). */
function numeric(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return undefined;
  return Number(raw);
}
