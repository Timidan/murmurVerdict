import { Agent } from "@openserv-labs/sdk";
import { z } from "zod";
import type Database from "better-sqlite3";
import { agentsRepo, resolutionsRepo, submissionsRepo } from "../verdict/db.js";
import { getLeaderboard, get24hVerifiedVolume } from "../verdict/leaderboard.js";
import {
  ERROR_CODES,
  REGISTERED_STRATEGY_TAGS,
  SCHEMA_VERSION,
  SCORING_VERSION,
  VerdictError,
} from "../verdict/schema.js";
import { submitCall, type SubmissionContext } from "../verdict/submissions.js";
import { verifyAgentApiKey } from "../verdict/auth.js";
import { projectCallRow } from "../verdict/projections.js";

// ─── Public params ───────────────────────────────────────────────────────────

export interface StartVerdictOpenServParams {
  db: Database.Database;
  ctx: SubmissionContext;
  port?: number;
  apiKey?: string;
  authToken?: string;
  systemPrompt?: string;
}

// Ensures we don't double-construct the agent in dev hot-reloads.
let singleton: Agent | null = null;

const SUBMIT_INPUT = z.object({
  agent_id: z.string().uuid(),
  api_key: z.string().min(16).max(128),
  client_order_id: z.string().min(8).max(128),
  asset_id: z.literal("base:ETH:USD"),
  side: z.enum(["BUY", "SELL"]),
  horizon_hours: z.union([z.literal(1), z.literal(4), z.literal(24), z.literal(168)]),
  confidence: z.number().min(0.51).max(0.95),
  submitted_at: z.string().datetime({ offset: false }),
  rationale: z.string().max(240).optional(),
  strategy_tag: z.enum(REGISTERED_STRATEGY_TAGS).optional(),
  privacy_mode: z.enum(["committed", "legacy_plaintext"]).optional(),
  salt: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
});

const ID_INPUT = z.object({ call_id: z.string().uuid() });
const SLUG_INPUT = z.object({ slug: z.string().min(3).max(48) });
const LB_INPUT = z.object({
  tier: z.enum(["main", "provisional"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function startVerdictOpenServAgent(
  params: StartVerdictOpenServParams,
): Promise<Agent | null> {
  if (process.env.OPENSERV_VERDICT_ENABLED === "false") {
    console.log("[openserv-verdict] disabled by config");
    return null;
  }
  if (singleton) return singleton;

  const port = params.port ?? Number(process.env.OPENSERV_VERDICT_PORT ?? 7378);
  const apiKey = params.apiKey ?? process.env.OPENSERV_API_KEY?.trim();
  const authToken = params.authToken ?? process.env.OPENSERV_AUTH_TOKEN?.trim();
  if (!apiKey) {
    console.warn("[openserv-verdict] OPENSERV_API_KEY not set — skipping agent registration");
    return null;
  }

  const agent = new Agent({
    apiKey,
    authToken,
    port,
    systemPrompt:
      params.systemPrompt ??
      "You are Murmur Verdict, the public benchmark and referee for autonomous market agents.",
  });

  agent.addCapabilities([
    {
      name: "submit_call",
      description:
        "Submit a market call (BUY/SELL ETH on Base over a 1/4/24/168h horizon with 0.51–0.95 confidence). Returns the call_id + oracle policy. Counts toward the agent's leaderboard rank when the call resolves against canonical Chainlink/Pyth feeds.",
      schema: SUBMIT_INPUT,
      async run({ args }) {
        // Auth via API key issued by the claim flow; same trust boundary as
        // POST /v1/calls. The OpenServ caller identity from the SDK is not
        // currently used as the auth principal — agents bring their own key.
        try {
          verifyAgentApiKey(params.db, args.agent_id, args.api_key);
        } catch (err) {
          if (err instanceof VerdictError) {
            return jsonError(err.httpStatus, err.code, err.message);
          }
          throw err;
        }
        const { api_key: _ignored, ...payload } = args;
        void _ignored;
        try {
          const result = await submitCall({
            db: params.db,
            ctx: params.ctx,
            identity: { agent_id: args.agent_id },
            payload: { schema_version: SCHEMA_VERSION, ...payload },
          });
          return JSON.stringify({
            kind: "verdict_submission",
            schema_version: SCHEMA_VERSION,
            scoring_version: SCORING_VERSION,
            ok: true,
            ...result,
          });
        } catch (err) {
          if (err instanceof VerdictError) {
            return jsonError(err.httpStatus, err.code, err.message, err.context);
          }
          throw err;
        }
      },
    },
    {
      name: "get_call",
      description:
        "Look up a call by call_id. Returns submission, oracle policy, t0 anchor (if anchored), and resolution (if resolved).",
      schema: ID_INPUT,
      async run({ args }) {
        const full = resolutionsRepo.loadFullCall(params.db, args.call_id);
        if (!full) return jsonError(404, "not_found", "call not found");
        const projectionMeta = params.db
          .prepare(
            `SELECT s.privacy_mode, s.commit_hash, cr.reveal_hash_valid
             FROM submissions s
             LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
             WHERE s.call_id = ?`,
          )
          .get(args.call_id) as
          | { privacy_mode: string | null; commit_hash: string | null; reveal_hash_valid: number | null }
          | undefined;
        const projected = projectCallRow({
          call_id: full.submission.call_id,
          status: full.submission.status,
          accepted_at: full.submission.accepted_at,
          privacy_mode: projectionMeta?.privacy_mode ?? null,
          commit_hash: projectionMeta?.commit_hash ?? null,
          // Wave 4b — receipts subsystem dropped; field surfaces null.
          acceptance_receipt_hash: null,
          side: full.submission.side,
          asset_id: full.submission.asset_id,
          horizon_hours: full.submission.horizon_hours,
          confidence: full.submission.confidence,
          rationale: full.submission.rationale,
          strategy_tag: full.submission.strategy_tag,
          submitted_at: full.submission.submitted_at,
          reveal_hash_valid: projectionMeta?.reveal_hash_valid ?? null,
        });
        const submission = {
          call_id: full.submission.call_id,
          agent_id: full.submission.agent_id,
          client_order_id: full.submission.client_order_id,
          accepted_at: full.submission.accepted_at,
          status: full.submission.status,
          privacy_mode: projected.privacy_mode,
          commit_hash: projected.commit_hash,
          ...(projected.side ? { side: projected.side } : {}),
          ...(projected.asset_id ? { asset_id: projected.asset_id } : {}),
          ...(projected.horizon_hours !== undefined ? { horizon_hours: projected.horizon_hours } : {}),
          ...(projected.confidence !== undefined ? { confidence: projected.confidence } : {}),
          ...(projected.rationale ? { rationale: projected.rationale } : {}),
          ...(projected.strategy_tag ? { strategy_tag: projected.strategy_tag } : {}),
          ...(projected.submitted_at ? { submitted_at: projected.submitted_at } : {}),
        };
        return JSON.stringify({
          kind: "verdict_call",
          schema_version: SCHEMA_VERSION,
          scoring_version: SCORING_VERSION,
          ...full,
          submission,
        });
      },
    },
    {
      name: "get_leaderboard",
      description:
        "Get the public leaderboard of verified + benchmark agents. Tier=main shows ranked agents (≥20 resolved); tier=provisional shows agents below threshold.",
      schema: LB_INPUT,
      async run({ args }) {
        const rows = getLeaderboard(params.db, {
          tier: args.tier,
          limit: args.limit ?? 50,
        });
        return JSON.stringify({
          kind: "verdict_leaderboard",
          schema_version: SCHEMA_VERSION,
          scoring_version: SCORING_VERSION,
          served_at: nowIso(),
          verified_volume_24h: get24hVerifiedVolume(params.db),
          rows,
        });
      },
    },
    {
      name: "get_agent",
      description: "Public profile by display_slug: kind, verified identities, creation date.",
      schema: SLUG_INPUT,
      async run({ args }) {
        const row = agentsRepo.bySlug(params.db, args.slug);
        if (!row) return jsonError(404, ERROR_CODES.unknown_agent, "agent not found");
        const { api_key_hash, ...publicProfile } = row;
        void api_key_hash;
        return JSON.stringify({
          result_kind: "verdict_agent",
          schema_version: SCHEMA_VERSION,
          agent: publicProfile,
        });
      },
    },
    {
      name: "get_agent_calls",
      description: "Recent calls (most recent first) for an agent. Useful for follow / mirror flows.",
      schema: SLUG_INPUT.extend({
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      async run({ args }) {
        const agentRow = agentsRepo.bySlug(params.db, args.slug);
        if (!agentRow) return jsonError(404, ERROR_CODES.unknown_agent, "agent not found");
        const rows = params.db
          .prepare(
            `SELECT s.call_id, s.status, s.asset_id, s.side, s.horizon_hours,
                    s.confidence, s.rationale, s.strategy_tag,
                    s.submitted_at, s.accepted_at, s.privacy_mode, s.commit_hash,
                    cr.reveal_hash_valid,
                    r.outcome, r.call_score, r.signed_return, r.resolved_at
             FROM submissions s
             LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
             LEFT JOIN call_reveals cr ON cr.call_id = s.call_id
             WHERE s.agent_id = ?
             ORDER BY s.accepted_at DESC
             LIMIT ?`,
          )
          .all(agentRow.agent_id, args.limit ?? 50) as Array<Record<string, unknown>>;
        const calls = rows.map((row) =>
          projectCallRow(
            {
              call_id: row.call_id as string,
              status: row.status as string,
              accepted_at: row.accepted_at as string,
              privacy_mode: row.privacy_mode as string | null,
              commit_hash: row.commit_hash as string | null,
              acceptance_receipt_hash: null,
              side: row.side as string | null,
              asset_id: row.asset_id as string | null,
              horizon_hours: row.horizon_hours as number | null,
              confidence: row.confidence as number | null,
              rationale: row.rationale as string | null,
              strategy_tag: row.strategy_tag as string | null,
              outcome: row.outcome as string | null,
              call_score: row.call_score as number | null,
              signed_return: row.signed_return as string | null,
              resolved_at: row.resolved_at as string | null,
              submitted_at: row.submitted_at as string | null,
              reveal_hash_valid: row.reveal_hash_valid as number | null,
            },
            agentRow.display_slug,
          ),
        );
        return JSON.stringify({
          kind: "verdict_agent_calls",
          schema_version: SCHEMA_VERSION,
          agent_id: agentRow.agent_id,
          display_slug: agentRow.display_slug,
          calls,
        });
      },
    },
    // Wave 4b-2 — `get_market_preflight` tool removed alongside the Santiment
    // integration. The tool returned composite_score / regime / top_playbook
    // decoration that the resolver never consulted. Murmur is a pure ranking
    // layer over canonical price/event oracles.
  ]);

  await agent.start();
  singleton = agent;
  console.log(
    `[openserv-verdict] agent listening on port ${port} with 5 referee capabilities`,
  );
  return agent;
}

export async function stopVerdictOpenServAgent(): Promise<void> {
  if (!singleton) return;
  // SDK does not yet expose a public stop(); we drop the reference and rely on
  // the underlying server to be GC'd / process to exit.
  singleton = null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function jsonError(
  httpStatus: number,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): string {
  return JSON.stringify({
    kind: "verdict_error",
    schema_version: SCHEMA_VERSION,
    ok: false,
    httpStatus,
    code,
    message,
    ...(context ? { context } : {}),
  });
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
