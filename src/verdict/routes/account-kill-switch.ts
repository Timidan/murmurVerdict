// ─── Account kill switch routes ──────────────────────────────────────────────
//
//   GET  /v1/account/kill-switch          — engaged state
//   POST /v1/account/kill-switch          — engage: disable dispatch/mints,
//                                           revoke all runtime keys, rotate
//                                           all API keys (one transaction)
//   POST /v1/account/kill-switch/release  — separate deliberate ceremony;
//                                           requires confirm phrase; does NOT
//                                           resurrect revoked credentials
//
// Privy auth ONLY (requireAccount): an agent credential must never be able to
// engage, read, or release the switch. Engage takes no confirm on purpose —
// an emergency lockout must be one click.

import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";

import {
  agentCredentialsDisabledAt,
  engageAccountKillSwitch,
  releaseAccountKillSwitch,
} from "../auth/accounts.js";
import type { RequireAccount } from "../account-route-auth.js";
import { ERROR_CODES, VerdictError } from "../schema.js";
import { asyncHandler } from "./async-handler.js";

export const KILL_SWITCH_RELEASE_CONFIRM = "release-agent-access";

export interface AccountKillSwitchRouterDeps {
  requireAccount: RequireAccount;
  db: Database.Database;
  json: RequestHandler;
  limiter: RequestHandler;
  now: () => Date;
}

export function accountKillSwitchRouter(
  deps: AccountKillSwitchRouterDeps,
): Router {
  const router = Router();
  const { requireAccount, db, json, limiter, now } = deps;

  router.get(
    "/v1/account/kill-switch",
    limiter,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const disabledAt = agentCredentialsDisabledAt(db, resolved.account_id);
      res.status(200).json({
        engaged: disabledAt !== null,
        disabled_at: disabledAt,
      });
    }),
  );

  router.post(
    "/v1/account/kill-switch",
    limiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const result = engageAccountKillSwitch(db, {
        account_id: resolved.account_id,
        actor: `privy:${resolved.account_id}`,
        now,
      });
      res.status(200).json({ engaged: true, ...result });
    }),
  );

  router.post(
    "/v1/account/kill-switch/release",
    limiter,
    json,
    asyncHandler(async (req, res) => {
      const resolved = await requireAccount(req);
      const confirm = (req.body as { confirm?: unknown } | undefined)?.confirm;
      if (confirm !== KILL_SWITCH_RELEASE_CONFIRM) {
        throw new VerdictError(
          `release requires { "confirm": "${KILL_SWITCH_RELEASE_CONFIRM}" }`,
          ERROR_CODES.schema_invalid,
          400,
        );
      }
      const result = releaseAccountKillSwitch(db, {
        account_id: resolved.account_id,
        actor: `privy:${resolved.account_id}`,
        now,
      });
      res.status(200).json({ engaged: false, ...result });
    }),
  );

  return router;
}
