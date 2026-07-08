import { z } from "zod";

import { agentsRepo } from "../verdict/repos/agents-repo.js";
import { marketsRepo } from "../verdict/repos/market-registry-repo.js";
import {
  getAgentMarketGrid,
  getLeaderboard,
  getLeaderboardRowForAgent,
  getLeaderboardForMarket,
  get24hVerifiedVolume,
} from "../verdict/leaderboard.js";
import {
  marketTaxonomyResponse,
} from "../verdict/market-taxonomy.js";
import {
  publicMarketRegistryRow,
  searchPublicMarkets,
} from "../verdict/market-registry-public.js";
import {
  listPublicAgentCallProjections,
  loadPublicSealedCallView,
} from "../verdict/sealed-call-public-projection.js";
import {
  ERROR_CODES,
  SCORING_VERSION,
} from "../verdict/schema.js";
import {
  buildDashboardLink,
  deepLinkPath,
  resolveLaunchpadOpenServLinks,
} from "./openserv-launchpad-links.js";
import {
  AGENT_CALLS_INPUT,
  AGENT_SCORECARD_INPUT,
  DEEPLINK_INPUT,
  ID_INPUT,
  LB_INPUT,
  MARKET_ID_INPUT,
  MARKET_RANK_INPUT,
  MARKET_SEARCH_INPUT,
} from "./openserv-launchpad-schemas.js";
import type {
  LaunchpadCapability,
  StartLaunchpadOpenServParams,
} from "./openserv-launchpad-types.js";
import {
  jsonError,
  okJson,
  publicAgent,
} from "./openserv-launchpad-presenters.js";

export function buildLaunchpadOpenServCapabilities(
  params: StartLaunchpadOpenServParams,
): LaunchpadCapability[] {
  const env = params.env ?? {};
  const resolvedParams = { ...params, env };
  const launchpadStage =
    params.launchpadStage ?? env.OPENSERV_LAUNCHPAD_STAGE ?? "prelaunch";
  const launchpadProjectId =
    params.launchpadProjectId ?? env.OPENSERV_LAUNCHPAD_PROJECT_ID ?? null;
  const launchpadProjectUrl =
    params.launchpadProjectUrl ?? env.OPENSERV_LAUNCHPAD_PROJECT_URL ?? null;
  const links = resolveLaunchpadOpenServLinks(resolvedParams);
  const ok = (kind: string, body: Record<string, unknown>): string =>
    okJson(kind, body, { servedAt: params.now() });
  return [
    {
      name: "get_market_taxonomy",
      description:
        "Return Murmur-native market taxonomy classes, including live and reserved classes for launchpad discovery.",
      schema: z.object({}),
      run() {
        return ok("murmur_market_taxonomy", {
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
        const limit = parsed.limit ?? 25;
        const rows = searchPublicMarkets(params.db, {
          status,
          query: parsed.query,
          adapter_id: parsed.adapter_id,
          market_family: parsed.market_family,
          resolution_class: parsed.resolution_class,
          limit,
        });
        return ok("murmur_market_search", {
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
        return ok("murmur_market", {
          market: publicMarketRegistryRow(market, { db: params.db }),
        });
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
        return ok("murmur_market_agent_rankings", {
          market: publicMarketRegistryRow(market, { db: params.db }),
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
        const leaderboard = getLeaderboardRowForAgent(params.db, row.agent_id);
        const grid = getAgentMarketGrid(params.db, row.agent_id, {
          limit: parsed.market_limit ?? 25,
        });
        return ok("murmur_agent_scorecard", {
          agent: publicAgent(row),
          leaderboard: leaderboard ?? null,
          market_grid: grid,
          links: {
            profile: buildDashboardLink(links, `/agents/${row.display_slug}`),
            calls: buildDashboardLink(links, `/agents/${row.display_slug}/calls`),
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
        const calls = listPublicAgentCallProjections({
          db: params.db,
          agent_id: agentRow.agent_id,
          agent_slug: agentRow.display_slug,
          limit: parsed.limit ?? 50,
        });
        return ok("murmur_public_agent_calls", {
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
        const view = loadPublicSealedCallView({
          db: params.db,
          call_id: parsed.call_id,
        });
        if (!view) return jsonError(404, "not_found", "call not found");
        return ok("murmur_public_call", { ...view });
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
        const servedAt = params.now();
        return okJson(
          "murmur_leaderboard",
          {
            scoring_version: SCORING_VERSION,
            verified_volume_24h: get24hVerifiedVolume(params.db, servedAt),
            rows,
          },
          { servedAt },
        );
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
        return ok("murmur_deeplink", {
          target: parsed.target,
          url: buildDashboardLink(links, path),
        });
      },
    },
    {
      name: "get_murmur_launch_status",
      description:
        "Return Murmur's OpenServ Launchpad metadata and public entry points. Does not expose private verdict or feed data.",
      schema: z.object({}),
      run() {
        return ok("murmur_openserv_launch_status", {
          stage: launchpadStage,
          launchpad_project_id: launchpadProjectId,
          launchpad_project_url: launchpadProjectUrl,
          dashboard_url: links.dashboardUrl,
          public_api_url: links.publicApiUrl,
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
