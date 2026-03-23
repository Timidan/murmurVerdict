import { Agent } from "@openserv-labs/sdk";
import { z } from "zod";

import { fetchUniverse } from "../scout/index.js";
import {
  getTopCandidates,
  normalizeUniverse,
  scoreUniverse,
} from "../analyst/index.js";
import {
  TESTNET_UNIVERSE,
  type AssetSlug,
  type DecisionLogEntry,
  type DecisionReceipt,
  type RiskGateResult,
  type ScoredAsset,
  type TreasuryState,
} from "../types/index.js";

export interface OpenServRuntime {
  getReceipts: () => DecisionReceipt[];
  getLastScoredAssets: () => ScoredAsset[];
  getLastRiskGate: () => RiskGateResult | null;
  getTreasuryState: () => TreasuryState | null;
  getCycleCount: () => number;
  getDecisionLog: () => DecisionLogEntry[];
}

export interface StartOpenServAgentParams {
  runtime: OpenServRuntime;
  apiKey?: string;
  port?: number;
  signalWindowDays?: number;
  candidateTopN?: number;
}

function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint" ? current.toString() : (current as unknown),
    2,
  );
}

function detectRegime(scoredAssets: ScoredAsset[]): "bullish" | "bearish" | "neutral" {
  if (scoredAssets.length === 0) return "neutral";
  const eth = scoredAssets.find((a) => a.slug === "ethereum") ?? scoredAssets[0]!;
  if (eth.topPlaybook === "early_narrative_breakout" && eth.compositeScore > 0.15) return "bullish";
  if (eth.topPlaybook === "euphoria_fade" && eth.compositeScore < -0.15) return "bearish";
  if (eth.topPlaybook === "capitulation_rebound" && eth.compositeScore > 0.15) return "bullish";
  return "neutral";
}

let singleton: Agent | null = null;

export async function startOpenServAgent(
  params: StartOpenServAgentParams,
): Promise<Agent | null> {
  if (process.env.OPENSERV_ENABLED === "false") {
    console.log("[openserv] Disabled by configuration");
    return null;
  }

  if (singleton) return singleton;

  const port = params.port ?? Number(process.env.OPENSERV_PORT ?? 7378);
  process.env.PORT = String(port);

  const apiKey = params.apiKey ?? process.env.OPENSERV_API_KEY?.trim();

  if (!apiKey) {
    console.warn("[openserv] OPENSERV_API_KEY not set — skipping OpenServ agent");
    return null;
  }

  const agent = new Agent({
    apiKey,
    systemPrompt: "You are Murmur, an autonomous DeFi trading agent. Use capabilities to report live data.",
  });

  agent.addCapabilities([
    {
      name: "get_market_regime",
      description: "Return current bullish/bearish/neutral regime and scored assets from the live loop.",
      schema: z.object({}),
      async run() {
        const scoredAssets = params.runtime.getLastScoredAssets();
        return toJson({
          regime: detectRegime(scoredAssets),
          cycleCount: params.runtime.getCycleCount(),
          treasury: params.runtime.getTreasuryState(),
          riskGate: params.runtime.getLastRiskGate(),
          latestDecision: params.runtime.getDecisionLog().at(-1) ?? null,
          scoredAssets,
        });
      },
    },
    {
      name: "get_latest_receipt",
      description: "Return the most recent decision receipt with Filecoin CID.",
      schema: z.object({}),
      async run() {
        const receipts = params.runtime.getReceipts();
        const latest = receipts.at(-1) ?? null;
        return toJson({
          totalReceipts: receipts.length,
          latestReceiptId: latest?.id ?? null,
          filecoinCid: latest?.filecoinCid ?? null,
          receipt: latest,
        });
      },
    },
    {
      name: "run_analysis",
      description: "Run the Santiment scoring pipeline on demand and return scored assets + regime.",
      schema: z.object({
        windowDays: z.coerce.number().int().min(1).max(90).optional(),
        topN: z.coerce.number().int().min(1).max(8).optional(),
      }),
      async run({ args }) {
        const santimentKey = process.env.SANTIMENT_API_KEY?.trim();
        if (!santimentKey) throw new Error("SANTIMENT_API_KEY required");

        const windowDays = args.windowDays ?? params.signalWindowDays ?? 30;
        const topN = args.topN ?? params.candidateTopN ?? 1;

        const universe = await fetchUniverse({
          apiKey: santimentKey,
          windowDays,
          interval: "1d",
          assets: [...TESTNET_UNIVERSE],
        });

        const normalized = normalizeUniverse(universe);
        const scoredAssets = scoreUniverse(normalized);
        const candidates = getTopCandidates(scoredAssets, topN);

        return toJson({
          ranAt: new Date().toISOString(),
          regime: detectRegime(scoredAssets),
          candidateCount: candidates.length,
          candidates,
          scoredAssets,
        });
      },
    },
  ]);

  await Promise.resolve(agent.start());

  console.log(`[openserv] Agent listening on http://localhost:${port}`);
  console.log(`[openserv] Capabilities: get_market_regime, get_latest_receipt, run_analysis`);
  singleton = agent;
  return agent;
}
