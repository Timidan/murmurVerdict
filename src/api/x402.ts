import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import type {
  DecisionReceipt,
  RiskGateResult,
  ScoredAsset,
  TreasuryState,
} from "../types/index.js";

export interface PaidSignalSnapshot {
  updatedAt: string;
  cycleCount: number;
  treasury: TreasuryState | null;
  scoredAssets: ScoredAsset[];
  riskGate: RiskGateResult | null;
}

export interface StartX402ServerParams {
  agentAddress: `0x${string}`;
  getLatestReceipts: () => DecisionReceipt[];
  getLatestSignalSnapshot: () => PaidSignalSnapshot;
  port?: number;
}

const DEFAULT_PORT = Number(process.env.X402_PORT ?? 4021);

export function startX402Server(params: StartX402ServerParams): Server | null {
  if (process.env.X402_ENABLED === "false") {
    console.log("[x402] Disabled by configuration");
    return null;
  }

  const app = express();
  app.use(express.json());

  // Health check
  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "murmur-x402",
      agentAddress: params.agentAddress,
    });
  });

  // Free: agent info
  app.get("/api/agent", (_req, res) => {
    sendJson(res, 200, {
      agent: "Murmur",
      address: params.agentAddress,
      description: "Autonomous DeFi operator — private reasoning, public execution, verifiable receipts",
      endpoints: {
        "/api/receipts/latest": "Latest decision receipts with Filecoin CIDs",
        "/api/signals/latest": "Live scored assets, risk gate state, treasury",
      },
    });
  });

  // Paid endpoint: latest receipts
  app.get("/api/receipts/latest", (req, res) => {
    const limit = parseLimit(req, 5, 20);
    const receipts = [...params.getLatestReceipts()].slice(-limit).reverse();

    sendJson(res, 200, {
      agentAddress: params.agentAddress,
      count: receipts.length,
      latestReceiptId: receipts[0]?.id ?? null,
      servedAt: new Date().toISOString(),
      receipts,
    });
  });

  // Paid endpoint: latest signals
  app.get("/api/signals/latest", (_req, res) => {
    const snapshot = params.getLatestSignalSnapshot();
    const topCandidates = [...snapshot.scoredAssets]
      .filter((a) => a.isCandidate)
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 5);

    sendJson(res, 200, {
      agentAddress: params.agentAddress,
      servedAt: new Date().toISOString(),
      updatedAt: snapshot.updatedAt,
      cycleCount: snapshot.cycleCount,
      treasury: snapshot.treasury,
      riskGate: snapshot.riskGate,
      topCandidates,
      scoredAssets: snapshot.scoredAssets,
    });
  });

  const port = params.port ?? DEFAULT_PORT;
  const server = app.listen(port, () => {
    console.log(`[x402] API server listening on http://localhost:${port}`);
    console.log(`[x402] Endpoints: GET /api/agent, /api/receipts/latest, /api/signals/latest`);
  });

  return server;
}

function parseLimit(req: Request, fallback: number, max: number): number {
  const raw = typeof req.query.limit === "string" ? Number(req.query.limit) : fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(raw)));
}

function sendJson(res: Response, status: number, payload: unknown): void {
  res
    .status(status)
    .type("application/json")
    .send(
      JSON.stringify(payload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : (value as unknown),
      ),
    );
}
