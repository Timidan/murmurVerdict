import { z } from "zod";
import type Database from "better-sqlite3";
import type { Agent as OpenServAgent } from "@openserv-labs/sdk";
import { agentsRepo, marketsRepo, resolutionsRepo } from "../verdict/db.js";
import {
  getAgentMarketGrid,
  getLeaderboard,
  getLeaderboardForMarket,
  get24hVerifiedVolume,
} from "../verdict/leaderboard.js";
import { adapterIdentityForMarket } from "../verdict/markets.js";
import {
  marketTaxonomyForMarket,
  marketTaxonomyResponse,
} from "../verdict/market-taxonomy.js";
import {
  ERROR_CODES,
  ResolutionClassSchema,
  SCHEMA_VERSION,
  SCORING_VERSION,
} from "../verdict/schema.js";
import { projectCallRow } from "../verdict/projections.js";

// ─── Public params ───────────────────────────────────────────────────────────

export interface StartLaunchpadOpenServParams {
  db: Database.Database;
  port?: number;
  apiKey?: string;
  authToken?: string;
  systemPrompt?: string;
  dashboardUrl?: string;
  publicApiUrl?: string;
  launchpadProjectId?: string;
  launchpadProjectUrl?: string;
  launchpadStage?: string;
}

type CapabilityRun = (params: { args: Record<string, unknown> }) => string | Promise<string>;

export interface LaunchpadCapability {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: CapabilityRun;
}

// Ensures we don't double-construct the agent in dev hot-reloads.
let singleton: OpenServAgent | null = null;

const ID_INPUT = z.object({ call_id: z.string().uuid() });
const SLUG_INPUT = z.object({ slug: z.string().min(3).max(48) });
const MARKET_ID_INPUT = z.object({ market_id: z.string().min(3).max(128) });
const LB_INPUT = z.object({
  tier: z.enum(["main", "provisional"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const MARKET_SEARCH_INPUT = z.object({
  query: z.string().min(1).max(128).optional(),
  status: z.enum(["draft", "listed", "frozen", "retired"]).optional(),
  adapter_id: z.string().min(2).max(64).optional(),
  market_family: z.string().min(2).max(64).optional(),
  resolution_class: ResolutionClassSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const MARKET_RANK_INPUT = MARKET_ID_INPUT.extend({
  tier: z.enum(["main", "provisional"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const AGENT_SCORECARD_INPUT = SLUG_INPUT.extend({
  market_limit: z.coerce.number().int().min(1).max(100).optional(),
});
const AGENT_CALLS_INPUT = SLUG_INPUT.extend({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const DEEPLINK_INPUT = z.discriminatedUnion("target", [
  z.object({ target: z.literal("home") }),
  z.object({ target: z.literal("leaderboard") }),
  z.object({ target: z.literal("launch") }),
  z.object({ target: z.literal("agent"), slug: z.string().min(3).max(48) }),
  z.object({ target: z.literal("agent_calls"), slug: z.string().min(3).max(48) }),
  z.object({ target: z.literal("market"), market_id: z.string().min(3).max(128) }),
  z.object({ target: z.literal("call"), call_id: z.string().uuid() }),
]);

export function buildLaunchpadOpenServCapabilities(
  params: StartLaunchpadOpenServParams,
): LaunchpadCapability[] {
  return [
    {
      name: "get_market_taxonomy",
      description:
        "Return Murmur-native market taxonomy classes, including live and reserved classes for launchpad discovery.",
      schema: z.object({}),
      run() {
        return okJson("murmur_market_taxonomy", {
          taxonomy: marketTaxonomyResponse(),
        });
      },
    },
    {
      name: "search_markets",
      description:
        "Search Murmur's public market registry. Returns only registry metadata plus adapter/family/taxonomy labels.",
      schema: MARKET_SEARCH_INPUT,
      run({ args }) {
        const parsed = MARKET_SEARCH_INPUT.parse(args);
        const status = parsed.status ?? "listed";
        const query = parsed.query?.trim().toLowerCase();
        const limit = parsed.limit ?? 25;
        const rows = marketsRepo
          .list(params.db, status)
          .map(publicMarket)
          .filter((market) => {
            if (parsed.adapter_id && market.adapter_id !== parsed.adapter_id) return false;
            if (parsed.market_family && market.market_family !== parsed.market_family) {
              return false;
            }
            if (
              parsed.resolution_class &&
              market.market_taxonomy.resolution_class !== parsed.resolution_class
            ) {
              return false;
            }
            if (!query) return true;
            return JSON.stringify(market).toLowerCase().includes(query);
          })
          .slice(0, limit);
        return okJson("murmur_market_search", {
          status,
          count: rows.length,
          markets: rows,
        });
      },
    },
    {
      name: "get_market",
      description:
        "Read one public Murmur market by market_id, including adapter, family, status, horizon, and public config summary.",
      schema: MARKET_ID_INPUT,
      run({ args }) {
        const parsed = MARKET_ID_INPUT.parse(args);
        const market = marketsRepo.get(params.db, parsed.market_id);
        if (!market) return jsonError(404, "unknown_market", "market not found");
        return okJson("murmur_market", { market: publicMarket(market) });
      },
    },
    {
      name: "rank_agents_for_market",
      description:
        "Rank public Murmur agents for a specific market. Useful for OpenServ launchpad users choosing which agent to inspect or follow.",
      schema: MARKET_RANK_INPUT,
      run({ args }) {
        const parsed = MARKET_RANK_INPUT.parse(args);
        const market = marketsRepo.get(params.db, parsed.market_id);
        if (!market) return jsonError(404, "unknown_market", "market not found");
        const agents = getLeaderboardForMarket(params.db, {
          market_id: parsed.market_id,
          tier: parsed.tier,
          limit: parsed.limit ?? 20,
        });
        return okJson("murmur_market_agent_rankings", {
          market: publicMarket(market),
          agents,
        });
      },
    },
    {
      name: "get_agent_scorecard",
      description:
        "Read a public Murmur agent scorecard: profile, global leaderboard row, per-market grid, and launchpad-safe deep links.",
      schema: AGENT_SCORECARD_INPUT,
      run({ args }) {
        const parsed = AGENT_SCORECARD_INPUT.parse(args);
        const row = agentsRepo.bySlug(params.db, parsed.slug);
        if (!row) return jsonError(404, ERROR_CODES.unknown_agent, "agent not found");
        const leaderboard = getLeaderboard(params.db, { limit: 500 }).find(
          (agent) => agent.agent_id === row.agent_id,
        );
        const grid = getAgentMarketGrid(params.db, row.agent_id).slice(
          0,
          parsed.market_limit ?? 25,
        );
        return okJson("murmur_agent_scorecard", {
          agent: publicAgent(row),
          leaderboard: leaderboard ?? null,
          market_grid: grid,
          links: {
            profile: buildDashboardLink(params, `/agents/${row.display_slug}`),
            calls: buildDashboardLink(params, `/agents/${row.display_slug}/calls`),
          },
        });
      },
    },
    {
      name: "get_public_agent_calls",
      description:
        "Return recent public call projections for an agent. Pending rows stay operator-blind; resolved rows include public outcome/score fields.",
      schema: AGENT_CALLS_INPUT,
      run({ args }) {
        const parsed = AGENT_CALLS_INPUT.parse(args);
        const agentRow = agentsRepo.bySlug(params.db, parsed.slug);
        if (!agentRow) return jsonError(404, ERROR_CODES.unknown_agent, "agent not found");
        const rows = params.db
          .prepare(
            `SELECT s.call_id, s.status, s.submitted_at, s.accepted_at,
                    s.privacy_mode, s.commit_hash,
                    r.outcome, r.call_score, r.signed_return, r.resolved_at
             FROM submissions s
             LEFT JOIN t1_resolutions r ON r.call_id = s.call_id
             WHERE s.agent_id = ?
             ORDER BY s.accepted_at DESC
             LIMIT ?`,
          )
          .all(agentRow.agent_id, parsed.limit ?? 50) as Array<Record<string, unknown>>;
        const calls = rows.map((row) =>
          projectCallRow(
            {
              call_id: row.call_id as string,
              status: row.status as string,
              accepted_at: row.accepted_at as string,
              privacy_mode: row.privacy_mode as string | null,
              commit_hash: row.commit_hash as string | null,
              acceptance_receipt_hash: null,
              outcome: row.outcome as string | null,
              call_score: row.call_score as number | null,
              signed_return: row.signed_return as string | null,
              resolved_at: row.resolved_at as string | null,
              submitted_at: row.submitted_at as string | null,
            },
            agentRow.display_slug,
          ),
        );
        return okJson("murmur_public_agent_calls", {
          agent: publicAgent(agentRow),
          calls,
        });
      },
    },
    {
      name: "get_public_call",
      description:
        "Read one public Murmur call. Pending calls expose commitment metadata only; resolved calls expose public score/outcome evidence.",
      schema: ID_INPUT,
      run({ args }) {
        const parsed = ID_INPUT.parse(args);
        const full = resolutionsRepo.loadFullCall(params.db, parsed.call_id);
        if (!full) return jsonError(404, "not_found", "call not found");
        const projectionMeta = params.db
          .prepare(
            `SELECT privacy_mode, commit_hash FROM submissions WHERE call_id = ?`,
          )
          .get(parsed.call_id) as
          | { privacy_mode: string | null; commit_hash: string | null }
          | undefined;
        const projected = projectCallRow({
          call_id: full.submission.call_id,
          status: full.submission.status,
          accepted_at: full.submission.accepted_at,
          privacy_mode: projectionMeta?.privacy_mode ?? null,
          commit_hash: projectionMeta?.commit_hash ?? null,
          acceptance_receipt_hash: null,
          submitted_at: full.submission.submitted_at,
        });
        return okJson("murmur_public_call", {
          submission: {
            call_id: full.submission.call_id,
            agent_id: full.submission.agent_id,
            market_id: full.submission.market_id,
            horizon_seconds: full.submission.horizon_seconds,
            accepted_at: full.submission.accepted_at,
            status: full.submission.status,
            privacy_mode: projected.privacy_mode,
            commit_hash: projected.commit_hash,
            ...(projected.submitted_at ? { submitted_at: projected.submitted_at } : {}),
          },
          t0: full.t0,
          resolution: full.resolution,
        });
      },
    },
    {
      name: "get_leaderboard",
      description:
        "Get Murmur's public leaderboard of scored agents. Tier=main shows ranked agents; tier=provisional shows agents below threshold.",
      schema: LB_INPUT,
      run({ args }) {
        const parsed = LB_INPUT.parse(args);
        const rows = getLeaderboard(params.db, {
          tier: parsed.tier,
          limit: parsed.limit ?? 50,
        });
        return okJson("murmur_leaderboard", {
          scoring_version: SCORING_VERSION,
          verified_volume_24h: get24hVerifiedVolume(params.db),
          rows,
        });
      },
    },
    {
      name: "create_murmur_deeplink",
      description:
        "Create a launchpad-safe Murmur dashboard link for a market, agent, call, leaderboard, launch page, or home page.",
      schema: DEEPLINK_INPUT,
      run({ args }) {
        const parsed = DEEPLINK_INPUT.parse(args);
        const path = deepLinkPath(parsed);
        return okJson("murmur_deeplink", {
          target: parsed.target,
          url: buildDashboardLink(params, path),
        });
      },
    },
    {
      name: "get_murmur_launch_status",
      description:
        "Return Murmur's OpenServ Launchpad metadata and public entry points. Does not expose private verdict or feed data.",
      schema: z.object({}),
      run() {
        return okJson("murmur_openserv_launch_status", {
          stage: params.launchpadStage ?? process.env.OPENSERV_LAUNCHPAD_STAGE ?? "prelaunch",
          launchpad_project_id:
            params.launchpadProjectId ?? process.env.OPENSERV_LAUNCHPAD_PROJECT_ID ?? null,
          launchpad_project_url:
            params.launchpadProjectUrl ?? process.env.OPENSERV_LAUNCHPAD_PROJECT_URL ?? null,
          dashboard_url: dashboardBaseUrl(params),
          public_api_url: publicApiUrl(params),
          capabilities: [
            "search_markets",
            "get_market_taxonomy",
            "get_market",
            "rank_agents_for_market",
            "get_agent_scorecard",
            "get_public_agent_calls",
            "get_public_call",
            "get_leaderboard",
            "create_murmur_deeplink",
          ],
        });
      },
    },
  ];
}

export async function startLaunchpadOpenServAgent(
  params: StartLaunchpadOpenServParams,
): Promise<OpenServAgent | null> {
  if (process.env.OPENSERV_LAUNCHPAD_ENABLED === "false") {
    console.log("[openserv-launchpad] disabled by config");
    return null;
  }
  if (singleton) return singleton;

  const port = params.port ?? Number(process.env.OPENSERV_LAUNCHPAD_PORT ?? 7378);
  const apiKey = params.apiKey ?? process.env.OPENSERV_API_KEY?.trim();
  const authToken = params.authToken ?? process.env.OPENSERV_AUTH_TOKEN?.trim();
  if (!apiKey) {
    console.warn("[openserv-launchpad] OPENSERV_API_KEY not set; skipping agent registration");
    return null;
  }

  const { Agent } = await import("@openserv-labs/sdk");
  const agent = new Agent({
    apiKey,
    authToken,
    port,
    systemPrompt:
      params.systemPrompt ??
      [
        "You are Murmur's OpenServ Launchpad agent.",
        "Help users discover public Murmur markets, agent scorecards, rankings, public calls, and dashboard links.",
        "You do not submit verdicts, touch private Fhenix data, score calls, resolve markets, or deliver subscriber feeds.",
      ].join(" "),
  });

  for (const capability of buildLaunchpadOpenServCapabilities(params)) {
    agent.addCapability(capability);
  }

  await agent.start();
  singleton = agent;
  console.log(
    `[openserv-launchpad] agent listening on port ${port} with ${buildLaunchpadOpenServCapabilities(params).length} public launchpad capabilities`,
  );
  return agent;
}

export async function stopLaunchpadOpenServAgent(): Promise<void> {
  if (!singleton) return;
  // SDK does not yet expose a public stop(); drop the reference and let the
  // process lifecycle own the underlying listener.
  singleton = null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function publicAgent(row: ReturnType<typeof agentsRepo.bySlug>) {
  if (!row) return null;
  const { api_key_hash, ...publicProfile } = row;
  void api_key_hash;
  return publicProfile;
}

function publicMarket(market: NonNullable<ReturnType<typeof marketsRepo.get>>) {
  return {
    market_id: market.market_id,
    asset_id: market.asset_id,
    market_kind: market.market_kind,
    horizon_seconds: market.horizon_seconds,
    scoring_kind: market.scoring_kind,
    market_config_version: market.market_config_version,
    status: market.status,
    void_band: market.void_band,
    round_cadence_seconds: market.round_cadence_seconds,
    notes: market.notes,
    created_at: market.created_at,
    ...adapterIdentityForMarket(market),
    market_taxonomy: marketTaxonomyForMarket(market),
    config: publicMarketConfigSummary(market.config_json),
  };
}

function publicMarketConfigSummary(configJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson || "{}");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  return {
    ...(typeof record.conditionId === "string" ? { conditionId: record.conditionId } : {}),
    ...(typeof record.slug === "string" ? { slug: record.slug } : {}),
    ...(Array.isArray(record.outcomes) ? { outcomes: record.outcomes } : {}),
    ...(typeof record.endDate === "string" ? { endDate: record.endDate } : {}),
    ...(typeof record.gamma_url === "string" ? { gamma_url: record.gamma_url } : {}),
  };
}

function okJson(kind: string, body: Record<string, unknown>): string {
  return JSON.stringify({
    kind,
    schema_version: SCHEMA_VERSION,
    served_at: nowIso(),
    ...body,
  });
}

function jsonError(
  httpStatus: number,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): string {
  return JSON.stringify({
    kind: "murmur_openserv_error",
    schema_version: SCHEMA_VERSION,
    ok: false,
    httpStatus,
    code,
    message,
    ...(context ? { context } : {}),
  });
}

function deepLinkPath(input: z.infer<typeof DEEPLINK_INPUT>): string {
  switch (input.target) {
    case "home":
      return "/";
    case "leaderboard":
      return "/leaderboard";
    case "launch":
      return "/launch";
    case "agent":
      return `/agents/${encodeURIComponent(input.slug)}`;
    case "agent_calls":
      return `/agents/${encodeURIComponent(input.slug)}/calls`;
    case "market":
      return `/markets/${encodeURIComponent(input.market_id)}`;
    case "call":
      return `/calls/${input.call_id}`;
  }
}

function buildDashboardLink(
  params: StartLaunchpadOpenServParams,
  hashPath: string,
): string {
  const base = dashboardBaseUrl(params);
  return `${base}/#${hashPath}`;
}

function dashboardBaseUrl(params: StartLaunchpadOpenServParams): string {
  return (
    params.dashboardUrl ??
    process.env.MURMUR_DASHBOARD_URL ??
    process.env.MURMUR_PUBLIC_URL ??
    "http://localhost:8080"
  ).replace(/\/$/, "");
}

function publicApiUrl(params: StartLaunchpadOpenServParams): string {
  return (
    params.publicApiUrl ??
    process.env.MURMUR_PUBLIC_URL ??
    "http://localhost:8080"
  ).replace(/\/$/, "");
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
