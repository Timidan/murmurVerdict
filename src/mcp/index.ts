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
//
// Wave 4b — verify_call dropped alongside the receipts subsystem; a
// leaner per-call verifier can be reintroduced later if needed.
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
  // Wave 2a — submit_call MCP tool removed. It posted plaintext
  // {asset_id, side, horizon_hours, confidence, privacy_mode} payloads
  // to /v1/calls, which now returns 410. Submitting under the new
  // FHE-mandatory contract requires the caller to encrypt the
  // predictedOutcome ciphertext client-side against the active
  // threshold keyset — that's a separate SDK surface, not in scope
  // for the MCP tool's "give me an LLM-friendly POST helper" role.
  // The read-only tools (get_leaderboard, get_agent, get_agent_score)
  // remain.
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
      // Wave 2a — case "submit_call" removed alongside submitCallViaApi.
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

// Wave 2a — submitCallViaApi removed alongside the submit_call MCP
// tool and the deleted /v1/calls endpoint. FHE-mandatory submission
// requires client-side ciphertext encryption against the active
// threshold keyset; that's a separate SDK surface, not in scope for
// the MCP tool's LLM-friendly-helper role. Read-only tools
// (get_leaderboard / get_agent / get_agent_score) remain.

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
