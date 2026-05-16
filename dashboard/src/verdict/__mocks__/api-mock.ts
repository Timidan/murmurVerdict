// Drop-in stand-in for `verdictApi` from ../api.ts.
//
// Every method matches the real client's signature + return type. Reads
// pull from ./fixtures; mutations call into the fixture mutators so the
// UI reflects writes (and the stream mock surfaces them as live events).
// A small artificial delay surfaces loading states without making the
// page feel slow.

import type {
  AccountAgent,
  AccountSession,
  AgentCallRow,
  AgentCrossFamilyRow,
  AgentFamilyRow,
  AgentGridSummary,
  AgentKind,
  AgentMarketRow,
  AgentProfile,
  ApiKeyRow,
  BindWalletResponse,
  ControllerIdentitySnapshot,
  ControllerWalletChallengeResponse,
  ControllerWalletReattestationChallengeResponse,
  ControllerWalletReattestationResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  FeedAvailabilityProof,
  FeedSlaAdminResponse,
  FeedSlaTickResponse,
  FhenixLifecycleSnapshot,
  FunnelEventKind,
  FullCall,
  GatewayOperatorSnapshot,
  GatewayRetryResponse,
  GatewayTickResponse,
  LeaderboardRow,
  LiveCanarySnapshot,
  MarketRow,
  MarketTaxonomyResponse,
  MetaResponse,
  MintApiKeyResponse,
  OperatorAlertsSnapshot,
  OperatorAlertTickResponse,
  PatchDestinationResponse,
  RotateApiKeyResponse,
  RuntimeKeyChallengeResponse,
  RuntimeKeyMintResponse,
  RuntimeKeyRow,
  TodayFeed,
} from "../api.js";
import { ApiError } from "../api.js";
import {
  ACCOUNT_AGENTS,
  AGENTS,
  API_KEYS,
  CALLS,
  MARKETS,
  REFS,
  getAgentCalls,
  getAgentGrid,
  getAgentProfile,
  getCallById,
  getDiscoverers,
  getFamilies,
  getFamilyLeaderboard,
  getLeaderboardRows,
  getMarketLeaderboard,
  getMarketRow,
  getMeta,
  getTaxonomyResponse,
  getTodayFeed,
  mutateCreateAgent,
  mutateMintApiKey,
  mutateRotateApiKey,
} from "./fixtures.js";
import { emitStreamEvent } from "./stream-mock.js";
import { hexId } from "./seed.js";

const MIN_DELAY = 40;
const MAX_DELAY = 180;

async function delay<T>(value: T): Promise<T> {
  const ms = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  await new Promise((r) => setTimeout(r, ms));
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ── Read helpers ──────────────────────────────────────────────────── */

export const mockApi = {
  apiUrl: "/mock",

  meta: () => delay(getMeta()),
  health: () =>
    delay({ ok: true, schema_version: 2, scoring_version: 4, now: nowIso() }),

  leaderboard: ({ tier, limit }: { tier?: "main" | "provisional"; limit?: number } = {}) => {
    let rows = getLeaderboardRows();
    if (tier) rows = rows.filter((r) => r.tier === tier);
    if (limit) rows = rows.slice(0, limit);
    return delay({
      schema_version: 2,
      scoring_version: 4,
      served_at: nowIso(),
      rows,
    });
  },

  agentsByKind: (kind: AgentKind, limit = 50) => {
    const rows = AGENTS.filter((a) => a.kind === kind)
      .slice(0, limit)
      .map((a): AgentProfile => ({
        agent_id: a.agent_id,
        display_slug: a.slug,
        display_name: a.display_name,
        kind: a.kind,
        bio: a.bio,
        created_at: a.created_at,
        wallet_address: a.wallet,
        chain_id: a.chain_id,
      }));
    return delay({
      schema_version: 2,
      served_at: nowIso(),
      kind,
      count: rows.length,
      rows,
    });
  },

  agent: async (slug: string): Promise<AgentProfile> => {
    const p = getAgentProfile(slug);
    if (!p) throw new ApiError(`GET /v1/agents/${slug} → 404`, 404);
    return delay(p);
  },

  agentCalls: async (slug: string, limit = 50) => {
    const p = getAgentProfile(slug);
    if (!p) throw new ApiError(`GET /v1/agents/${slug}/calls → 404`, 404);
    const calls: AgentCallRow[] = getAgentCalls(slug, limit);
    return delay({
      agent_id: p.agent_id,
      display_slug: p.display_slug,
      kind: p.kind,
      calls,
    });
  },

  call: async (call_id: string): Promise<FullCall> => {
    const c = getCallById(call_id);
    if (!c) throw new ApiError(`GET /v1/calls/${call_id} → 404`, 404);
    return delay(c);
  },

  todayFeed: (): Promise<TodayFeed> => delay(getTodayFeed()),

  feedAvailability: async (feed_id: string) => {
    const proof: FeedAvailabilityProof = {
      proof_version: 1,
      feed_id,
      health_status: "healthy",
      reliability_score: 0.984,
      scheduled_packets: 144,
      on_time_packets: 140,
      late_packets: 3,
      missed_packets: 1,
      open_missed_packets: 0,
      fulfilled_missed_packets: 1,
      next_expected_sequence: 145,
      next_deadline_at: new Date(Date.now() + 600_000).toISOString(),
      overdue: false,
      overdue_grace_seconds: 60,
      refund_recommendations: {},
      slash_recommendations: {},
      payment_execution_enabled: false,
      proof_hash: hexId(`feed:${feed_id}`, 64),
      generated_at: nowIso(),
      agent_id: AGENTS[0].agent_id,
      feed: {
        status: "active",
        venue: "chainlink",
        delivery_cadence_seconds: 600,
        max_latency_seconds: 30,
        refund_rule: {},
        slash_rule: {},
      },
      window: {
        from: new Date(Date.now() - 86_400_000).toISOString(),
        to: nowIso(),
      },
      evidence: { delivered_packets: [], missed_packets: [] },
    };
    return delay({ schema_version: 1, served_at: nowIso(), proof });
  },

  discoverers: (slug: string, limit = 5) =>
    delay({ schema_version: 1, slug, discoverers: getDiscoverers(slug, limit) }),

  topRefs: (limit = 20) =>
    delay({
      schema_version: 1,
      served_at: nowIso(),
      senders: REFS.slice(0, limit).map((r) => ({
        ref: r.ref,
        total: r.total,
        agents_touched: r.agents_touched,
        converted: r.converted,
        last_at: r.last_at,
      })),
    }),

  /* ── Markets ─────────────────────────────────────────────────────── */

  markets: ({ status, asset_id }: { status?: string; asset_id?: string } = {}) => {
    let rows = MARKETS.slice();
    if (status) rows = rows.filter((m) => m.status === status);
    if (asset_id) rows = rows.filter((m) => m.asset_id === asset_id);
    const markets: MarketRow[] = rows.map(getMarketRow);
    return delay({
      markets,
      taxonomy: getTaxonomyResponse(),
      served_at: nowIso(),
    });
  },

  marketTaxonomy: () =>
    delay({
      schema_version: 4,
      served_at: nowIso(),
      taxonomy: getTaxonomyResponse(),
    }),

  marketLeaderboard: async (
    market_id: string,
    { limit, tier }: { limit?: number; tier?: string } = {},
  ) => {
    const m = MARKETS.find((x) => x.market_id === market_id);
    if (!m) throw new ApiError(`GET /v1/markets/${market_id}/leaderboard → 404`, 404);
    let agents = getMarketLeaderboard(market_id, limit ?? 50);
    if (tier === "main") agents = agents.filter((a) => a.market_main_tier);
    if (tier === "provisional") agents = agents.filter((a) => !a.market_main_tier);
    return delay({ market_id, agents, served_at: nowIso() });
  },

  families: () =>
    delay({
      ...getFamilies(),
      served_at: nowIso(),
    }),

  familyLeaderboard: async (
    family: string,
    { limit, tier }: { limit?: number; tier?: "main" | "provisional" } = {},
  ) => {
    let agents: AgentFamilyRow[] = getFamilyLeaderboard(family, limit ?? 50);
    if (tier === "main") agents = agents.filter((a) => a.family_main_tier);
    if (tier === "provisional") agents = agents.filter((a) => !a.family_main_tier);
    return delay({ market_family: family, agents, served_at: nowIso() });
  },

  crossFamilyLeaderboard: ({ limit }: { limit?: number } = {}) => {
    const rows: AgentCrossFamilyRow[] = AGENTS.filter((a) => a.resolved_calls >= 5)
      .slice(0, limit ?? 50)
      .map((a) => ({
        agent_id: a.agent_id,
        display_slug: a.slug,
        display_name: a.display_name,
        kind: a.kind,
        cross_family_score: a.verdict_score === null ? null : a.verdict_score * 0.95,
        families: [
          {
            market_family: "native-price",
            verdict_score: a.verdict_score,
            resolved_calls: Math.round(a.resolved_calls * 0.8),
            qualifies: a.resolved_calls >= 20,
          },
          {
            market_family: "event",
            verdict_score: a.verdict_score === null ? null : a.verdict_score * 0.8,
            resolved_calls: Math.round(a.resolved_calls * 0.2),
            qualifies: a.resolved_calls >= 100,
          },
        ],
        qualifying_families: a.resolved_calls >= 100 ? 2 : a.resolved_calls >= 20 ? 1 : 0,
        cross_family_main_tier: a.resolved_calls >= 100,
      }))
      .sort((a, b) => (b.cross_family_score ?? -Infinity) - (a.cross_family_score ?? -Infinity));
    return delay({ agents: rows, served_at: nowIso() });
  },

  agentGrid: async (slug: string) => {
    const g = getAgentGrid(slug);
    if (!g) throw new ApiError(`GET /v1/agents/${slug}/grid → 404`, 404);
    return delay({ ...g, served_at: nowIso() });
  },

  /* ── Account-area (Privy bearer) — mock accepts any non-empty token ─ */

  postAccountSession: (privyToken: string) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    const session: AccountSession = {
      account_id: "acc_" + hexId(`acc:${privyToken.slice(0, 12)}`, 16),
      created: false,
      privy_user_id: "did:privy:mock-user",
    };
    return delay(session);
  },

  getAccountAgents: (privyToken: string) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    return delay({ agents: ACCOUNT_AGENTS as AccountAgent[] });
  },

  postCreateAgent: async (privyToken: string, body: CreateAgentRequest) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    if (AGENTS.some((a) => a.slug === body.display_slug)) {
      throw new ApiError(
        `POST /v1/account/agents → 409: ${JSON.stringify({ code: "duplicate" })}`,
        409,
        JSON.stringify({ code: "duplicate" }),
      );
    }
    const created = mutateCreateAgent(body.display_slug, body.display_name, body.bio);
    emitStreamEvent({ kind: "agent.created", slug: created.slug });
    const res: CreateAgentResponse = {
      agent_id: created.agent_id,
      display_slug: created.slug,
      display_name: created.display_name,
      kind: "agent",
      created_at: created.created_at,
    };
    return delay(res);
  },

  postMintApiKey: async (privyToken: string, slug: string, label?: string) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    const row = mutateMintApiKey(slug, label);
    const res: MintApiKeyResponse = {
      api_key_id: row.api_key_id,
      secret: "mrk_" + hexId(`secret:${row.api_key_id}`, 40),
      created_at: row.created_at,
      warning: "This is the only time this secret will be shown.",
    };
    return delay(res);
  },

  getApiKeys: async (privyToken: string, slug: string) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    return delay({ keys: (API_KEYS[slug] ?? []) as ApiKeyRow[] });
  },

  deleteApiKey: async (privyToken: string, key_id: string) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    const ok = mutateRotateApiKey(key_id);
    const res: RotateApiKeyResponse = { rotated: ok };
    return delay(res);
  },

  patchDestinationAddress: async (privyToken: string, slug: string, address: string) => {
    if (!privyToken) throw new ApiError("missing token", 401);
    const target = ACCOUNT_AGENTS.find((a) => a.display_slug === slug);
    if (target) {
      target.destination_address = address;
      target.destination_address_updated_at = nowIso();
    }
    const res: PatchDestinationResponse = {
      agent_id: target?.agent_id ?? "ag_mock",
      destination_address: address,
      destination_address_updated_at: target?.destination_address_updated_at ?? nowIso(),
    };
    return delay(res);
  },

  postControllerWalletChallenge: async (privyToken: string, slug: string, body: {
    wallet_address: string;
    chain_id: string;
    wallet_kind?: "embedded" | "external";
    provider?: string;
  }) => {
    const res: ControllerWalletChallengeResponse = {
      agent_id: "ag_mock",
      display_slug: slug,
      wallet_address: body.wallet_address,
      chain_id: body.chain_id,
      wallet_kind: body.wallet_kind ?? "embedded",
      provider: body.provider ?? null,
      authorization_issued_at: nowIso(),
      message: `Murmur Verdict mock challenge for ${slug}`,
    };
    return delay(res);
  },

  patchAgentWallet: async (privyToken: string, slug: string, body: { wallet_address: string; chain_id: string }) => {
    const res: BindWalletResponse = {
      agent_id: "ag_mock",
      display_slug: slug,
      wallet_address: body.wallet_address,
      chain_id: body.chain_id,
      wallet_kind: "embedded",
      provider: "privy",
      created_at: nowIso(),
      last_attested_at: nowIso(),
      reattestation_due_at: new Date(Date.now() + 60_000 * 60 * 24 * 30).toISOString(),
      reattestation_overdue: false,
      reattestation_interval_seconds: 60 * 60 * 24 * 30,
      idempotent_hit: false,
    };
    return delay(res);
  },

  postControllerWalletReattestationChallenge: async (privyToken: string, slug: string) => {
    const res: ControllerWalletReattestationChallengeResponse = {
      agent_id: "ag_mock",
      display_slug: slug,
      controller_wallet_address: "0x0000000000000000000000000000000000000000",
      controller_chain_id: "eip155:8453",
      attestation_nonce: hexId(`nonce:${slug}:${Date.now()}`, 24),
      authorization_issued_at: nowIso(),
      previous_last_attested_at: nowIso(),
      previous_reattestation_due_at: nowIso(),
      reattestation_interval_seconds: 60 * 60 * 24 * 30,
      message: "Reattest your controller wallet for " + slug,
    };
    return delay(res);
  },

  postControllerWalletReattestation: async (privyToken: string, slug: string) => {
    const res: ControllerWalletReattestationResponse = {
      agent_id: "ag_mock",
      display_slug: slug,
      attestation_id: hexId(`att:${slug}:${Date.now()}`, 16),
      controller_wallet: {
        wallet_address: "0x0000000000000000000000000000000000000000",
        chain_id: "eip155:8453",
        wallet_kind: "embedded",
        provider: "privy",
        created_at: nowIso(),
        last_attested_at: nowIso(),
        reattestation_due_at: new Date(Date.now() + 60_000 * 60 * 24 * 30).toISOString(),
        reattestation_overdue: false,
        reattestation_interval_seconds: 60 * 60 * 24 * 30,
      },
    };
    return delay(res);
  },

  getRuntimeKeys: async (privyToken: string, slug: string) => {
    const keys: RuntimeKeyRow[] = [];
    return delay({ keys });
  },

  postRuntimeKeyChallenge: async (privyToken: string, slug: string) => {
    const res: RuntimeKeyChallengeResponse = {
      agent_id: "ag_mock",
      display_slug: slug,
      controller_wallet_address: "0x0000000000000000000000000000000000000000",
      controller_chain_id: "eip155:8453",
      policy_hash: hexId(`policy:${slug}`, 32),
      authorization_nonce: hexId(`nonce:${slug}:${Date.now()}`, 24),
      authorization_issued_at: nowIso(),
      expires_at: null,
      message: "Authorize runtime key mint",
    };
    return delay(res);
  },

  postRuntimeKey: async (privyToken: string, slug: string) => {
    const res: RuntimeKeyMintResponse = {
      runtime_key_id: hexId(`rk:${slug}:${Date.now()}`, 16),
      secret: "mrk_rt_" + hexId(`rkscr:${slug}`, 40),
      runtime_key_prefix: "mrk_rt_" + hexId(`rk:${slug}`, 6),
      label: null,
      policy_hash: hexId(`policy:${slug}`, 32),
      created_at: nowIso(),
      expires_at: null,
    };
    return delay(res);
  },

  deleteRuntimeKey: async () => delay({ revoked: true }),

  postFunnelEvent: async (
    _privyToken: string,
    _kind: FunnelEventKind,
    _attributes?: Record<string, unknown>,
  ): Promise<void> => {
    // No-op in mock mode. Real impl is a 204.
    await delay(null);
  },

  /* ── Admin (X-Admin-Token) — mock accepts any non-empty token ────── */

  adminGateway: async (token: string): Promise<GatewayOperatorSnapshot> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      served_at: nowIso(),
      configured: true,
      config: {
        chain_id: 8453,
        contract_address: "0x" + hexId("gateway:contract", 40),
        relayer_address: "0x" + hexId("gateway:relayer", 40),
        confirmations: 3,
        retry_base_ms: 500,
        retry_max_ms: 30_000,
        max_attempts: 6,
        stuck_after_ms: 60_000,
      },
      queues: {
        due_for_broadcast: 2,
        submitted_awaiting_confirmation: 4,
        confirmed_awaiting_acceptance: 1,
        stuck: 0,
        stale_before: nowIso(),
      },
      status_counts: {
        queued: 2,
        submitted: 4,
        confirmed: 1,
        accepted: 240,
        failed_retryable: 0,
        failed_terminal: 1,
      },
      telemetry: {
        avg_broadcast_latency_ms: 480,
        avg_receipt_latency_ms: 1840,
        avg_latest_block_latency_ms: 120,
        max_confirmations_observed: 6,
        rpc_errors: 0,
        last_receipt_observed_at: nowIso(),
      },
      recent_attempts: [],
      stuck_attempts: [],
      feed_queues: {
        due_for_broadcast: 0,
        submitted_awaiting_confirmation: 0,
        confirmed_awaiting_acceptance: 0,
        stuck: 0,
        stale_before: nowIso(),
      },
      feed_status_counts: {
        queued: 0,
        submitted: 0,
        confirmed: 0,
        accepted: 0,
        failed_retryable: 0,
        failed_terminal: 0,
      },
      feed_telemetry: {
        avg_broadcast_latency_ms: null,
        avg_receipt_latency_ms: null,
        avg_latest_block_latency_ms: null,
        max_confirmations_observed: null,
        rpc_errors: 0,
        last_receipt_observed_at: null,
      },
      feed_recent_attempts: [],
      feed_stuck_attempts: [],
    });
  },

  adminGatewayTick: async (token: string): Promise<GatewayTickResponse> => {
    const gw = await mockApi.adminGateway(token);
    return {
      schema_version: 1,
      served_at: nowIso(),
      result: { broadcasted: 1, confirmed: 1, accepted: 1, failed: 0 },
      gateway: gw,
    };
  },

  adminGatewayRetry: async (): Promise<GatewayRetryResponse> => ({
    schema_version: 1,
    served_at: nowIso(),
    attempt_id: hexId("att:mock", 16),
    status: "submitted",
    tx_hash: "0x" + hexId("tx:mock", 64),
    call_id: null,
    next_attempt_at: nowIso(),
    idempotent_hit: false,
  }),

  adminCanaries: async (token: string): Promise<LiveCanarySnapshot> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      served_at: nowIso(),
      ok: true,
      checks: [
        {
          name: "fhenix_rpc",
          status: "ok",
          checked_at: nowIso(),
          latency_ms: 92,
          details: { block: 4_582_117 },
          error: null,
        },
        {
          name: "polymarket_gamma",
          status: "ok",
          checked_at: nowIso(),
          latency_ms: 184,
          details: { responding: true },
          error: null,
        },
      ],
    });
  },

  adminCanariesTick: async (token: string) => mockApi.adminCanaries(token),

  adminFhenixLifecycle: async (token: string): Promise<FhenixLifecycleSnapshot> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      served_at: nowIso(),
      configured: { verifier: true, watcher: true, reveal_grace_seconds: 60 },
      counts: { pending: 6, revealed: 240, invalid: 1, missed: 0 },
      queues: {
        pending_not_open: 1,
        open_pending: 5,
        overdue_grace: 0,
        terminal_failures: 1,
        needs_attention: 1,
        grace_cutoff: nowIso(),
      },
      cursors: [],
      event_counts: { CallSealed: 246, CallRevealed: 240, CallInvalid: 1 },
      needs_attention: [],
      recent: [],
    });
  },

  adminIdentityControllers: async (token: string): Promise<ControllerIdentitySnapshot> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      served_at: nowIso(),
      due_soon_at: new Date(Date.now() + 60_000 * 60 * 24 * 3).toISOString(),
      counts: {
        controller_wallets: 18,
        overdue: 0,
        due_soon: 2,
        active_runtime_keys: 11,
        needs_attention: 2,
      },
      needs_attention: [],
      rows: [],
    });
  },

  adminOperatorAlerts: async (token: string): Promise<OperatorAlertsSnapshot> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      served_at: nowIso(),
      sink_configured: true,
      counts: {
        open: { total: 1, critical: 0, warning: 1, info: 0 },
        resolved: { total: 4, critical: 0, warning: 3, info: 1 },
      },
      alerts: [],
    });
  },

  adminOperatorAlertsTick: async (token: string): Promise<OperatorAlertTickResponse> => {
    const snap = await mockApi.adminOperatorAlerts(token);
    return {
      schema_version: 1,
      scan: {
        served_at: nowIso(),
        opened_or_seen: 1,
        sources: [],
      },
      delivery: {
        served_at: nowIso(),
        sink_configured: true,
        attempted: 1,
        delivered: 1,
        failed: 0,
      },
      snapshot: snap,
    };
  },

  adminFeedSla: async (token: string): Promise<FeedSlaAdminResponse> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      served_at: nowIso(),
      summary: {
        open_incidents: 0,
        refund_recommendations: 0,
        slash_recommendations: 0,
        failing_feeds: 0,
        degraded_feeds: 1,
        payment_execution_enabled: false,
      },
      feed_health: [],
      incidents: [],
    });
  },

  adminFeedSlaTick: async (token: string): Promise<FeedSlaTickResponse> => {
    if (!token) throw new ApiError("admin token required", 403);
    return delay({
      schema_version: 1,
      result: {
        served_at: nowIso(),
        inspected_feeds: 0,
        incidents_opened: 0,
        max_incidents: 100,
      },
      open_incidents: [],
    });
  },
};

/* ── Helpers used by stream-mock to fold deltas back into REST ─────── */

export function snapshotLeaderboardForStream(): LeaderboardRow[] {
  return getLeaderboardRows().slice(0, 40);
}

export function snapshotMarketAgents(market_id: string): AgentMarketRow[] {
  return getMarketLeaderboard(market_id, 8);
}
