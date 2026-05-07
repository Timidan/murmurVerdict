#!/usr/bin/env tsx
// Murmur Verdict MCP server — stdio transport.
//
// Lets any MCP-aware agent (OpenServ, Claude Desktop, Cursor, Codex,
// Goose, Continue) consume Murmur as a referee. Exposed tools:
//
//   - get_leaderboard       List ranked agents.
//   - get_agent             Fetch profile + recent calls for one agent.
//   - get_agent_score       Single-call lookup of an agent's verdict score.
//   - submit_call           HMAC-authenticated call submission.
//   - verify_call           Re-run the receipt-chain verifier.
//
// Backend: this server speaks to the running Murmur daemon via HTTP. We
// keep the MCP layer thin — protocol concerns live in the SDK, business
// logic stays in the verdict package. Configure with VERDICT_API_URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const VERDICT_API_URL = (process.env.VERDICT_API_URL ?? "http://localhost:8080").replace(/\/$/, "");
const VERDICT_AGENT_ID = process.env.VERDICT_AGENT_ID;
const VERDICT_API_KEY = process.env.VERDICT_API_KEY;

const TOOLS: Tool[] = [
  {
    name: "get_leaderboard",
    description:
      "Returns the current Murmur Verdict leaderboard. Each row carries rank, agent name, slug, verdict score (σ-units), win rate, resolved-call count, and pending-call count. Use this when the user asks 'who is winning' or to compare agents.",
    inputSchema: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: ["main", "provisional"],
          description: "Filter to one tier. Omit for all.",
        },
        limit: { type: "number", default: 50, minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "get_agent",
    description:
      "Fetch one agent's full profile (kind, tier, verified identities, bio) plus their N most recent calls. Use this for deep dives on a single agent.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: { type: "string", description: "Agent display slug, e.g. shadow-x-cryptocred" },
        recent_calls: { type: "number", default: 25, minimum: 0, maximum: 200 },
      },
    },
  },
  {
    name: "get_agent_score",
    description:
      "Compact single-line lookup of an agent's current verdict score, win rate, and rank. Designed for inline use inside a chat or tool chain.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: { type: "string" },
      },
    },
  },
  {
    name: "submit_call",
    description:
      "Submit a market call to Murmur for scoring. Requires VERDICT_AGENT_ID + VERDICT_API_KEY in the server environment (set them when registering this MCP server). The call is scored against canonical Chainlink + Pyth feeds at horizon expiry.",
    inputSchema: {
      type: "object",
      required: [
        "client_order_id",
        "asset_id",
        "side",
        "horizon_hours",
        "confidence",
      ],
      properties: {
        client_order_id: {
          type: "string",
          description: "Idempotency key — the same value returns the same call_id on retry.",
        },
        asset_id: { type: "string", description: "e.g. ETH or BTC" },
        side: { type: "string", enum: ["BUY", "SELL"] },
        horizon_hours: { type: "number", description: "1, 4, or 24 typical" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string" },
        strategy_tag: { type: "string" },
      },
    },
  },
  {
    name: "verify_call",
    description:
      "Re-run Murmur's receipt-chain verifier against a known call_id. Returns the full check matrix with pass/fail per check (acceptance hash, t0 anchor, t1 resolution, scoring).",
    inputSchema: {
      type: "object",
      required: ["call_id"],
      properties: {
        call_id: { type: "string" },
      },
    },
  },
];

const server = new Server(
  { name: "murmur-verdict", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "get_leaderboard":
        return text(await getLeaderboard(args ?? {}));
      case "get_agent":
        return text(await getAgent(args ?? {}));
      case "get_agent_score":
        return text(await getAgentScore(args ?? {}));
      case "submit_call":
        return text(await submitCallViaApi(args ?? {}));
      case "verify_call":
        return text(await verifyCall(args ?? {}));
      default:
        return error(`unknown tool: ${name}`);
    }
  } catch (err) {
    return error(err instanceof Error ? err.message : String(err));
  }
});

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function getLeaderboard(args: Record<string, unknown>) {
  const params = new URLSearchParams();
  if (typeof args.tier === "string") params.set("tier", args.tier);
  if (typeof args.limit === "number") params.set("limit", String(args.limit));
  const q = params.toString();
  return await getJson(`/v1/leaderboard${q ? `?${q}` : ""}`);
}

async function getAgent(args: Record<string, unknown>) {
  const slug = requireString(args, "slug");
  const limit = typeof args.recent_calls === "number" ? args.recent_calls : 25;
  const [profile, calls] = await Promise.all([
    getJson(`/v1/agents/${encodeURIComponent(slug)}`),
    limit > 0
      ? getJson(`/v1/agents/${encodeURIComponent(slug)}/calls?limit=${limit}`)
      : Promise.resolve({ calls: [] }),
  ]);
  return { profile, calls };
}

async function getAgentScore(args: Record<string, unknown>) {
  const slug = requireString(args, "slug");
  const board = (await getJson(`/v1/leaderboard?limit=200`)) as {
    rows: Array<{
      display_slug: string;
      display_name: string;
      rank: number | null;
      verdict_score: number | null;
      win_rate: number | null;
      resolved_calls: number;
      pending_calls: number;
    }>;
  };
  const row = board.rows.find((r) => r.display_slug === slug);
  if (!row) return { found: false, slug };
  return {
    found: true,
    slug,
    display_name: row.display_name,
    rank: row.rank,
    verdict_score: row.verdict_score,
    win_rate: row.win_rate,
    resolved_calls: row.resolved_calls,
    pending_calls: row.pending_calls,
  };
}

async function submitCallViaApi(args: Record<string, unknown>) {
  if (!VERDICT_AGENT_ID || !VERDICT_API_KEY) {
    throw new Error(
      "submit_call requires VERDICT_AGENT_ID and VERDICT_API_KEY in the MCP server environment. Claim a profile via the dashboard first.",
    );
  }
  const body = {
    schema_version: 1,
    agent_id: VERDICT_AGENT_ID,
    client_order_id: requireString(args, "client_order_id"),
    asset_id: requireString(args, "asset_id"),
    side: requireString(args, "side"),
    horizon_hours: requireNumber(args, "horizon_hours"),
    confidence: requireNumber(args, "confidence"),
    submitted_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    rationale: typeof args.rationale === "string" ? args.rationale : undefined,
    strategy_tag: typeof args.strategy_tag === "string" ? args.strategy_tag : undefined,
  };
  return await postJson("/v1/calls", body, {
    "X-Murmur-Agent-Id": VERDICT_AGENT_ID,
    "X-Murmur-Api-Key": VERDICT_API_KEY,
  });
}

async function verifyCall(args: Record<string, unknown>) {
  const callId = requireString(args, "call_id");
  return await getJson(`/v1/calls/${encodeURIComponent(callId)}/verify`);
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${VERDICT_API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return await res.json();
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`${VERDICT_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

function text(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function error(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string '${key}'`);
  }
  return v;
}

function requireNumber(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(`missing required number '${key}'`);
  }
  return v;
}

// ─── Boot ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No console output — MCP stdio transport reserves stdout/stderr for protocol frames.
}

main().catch((err) => {
  console.error("[murmur-mcp] fatal:", err);
  process.exit(1);
});
