import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import {
  FhenixEventVerificationError,
  fhenixMarketIdForMurmurMarket,
  type FhenixEventVerifier,
  type VerifiedSealedCallSubmitted,
  type VerifiedVerdictRevealInvalid,
  type VerifiedVerdictRevealed,
  type VerifyVerdictRevealInvalidInput,
  type VerifySealedCallSubmittedInput,
  type VerifyVerdictRevealedInput,
} from "../integrations/fhenix-events.js";
import {
  agentsRepo,
  marketsRepo,
  openDb,
  resolutionsRepo,
  submissionsRepo,
} from "./db.js";
import { createVerdictRouter } from "./api.js";
import {
  bindControllerWallet,
  getOrCreateAccount,
  linkAgentToAccount,
} from "./auth/accounts.js";
import { Resolver } from "./resolver.js";
import {
  PolymarketClobClient,
  PolymarketGammaClient,
  setDefaultPolymarketClient,
  setDefaultPolymarketClobClient,
} from "../markets/polymarket-gamma/index.js";

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  fail ${name}\n`);
    process.stdout.write(`      ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

class SmokeFhenixVerifier implements FhenixEventVerifier {
  mode: "ok" | "agent_mismatch" = "ok";

  async verifySealedCallSubmitted(
    input: VerifySealedCallSubmittedInput,
  ): Promise<VerifiedSealedCallSubmitted> {
    if (this.mode === "agent_mismatch") {
      throw new FhenixEventVerificationError(
        "Fhenix event agent mismatch",
        "event_mismatch",
        {
          expected: input.expected_agent_wallet,
          actual: "0x9999999999999999999999999999999999999999",
        },
      );
    }
    return {
      chain_id: input.chain_id,
      contract_address: input.contract_address.toLowerCase(),
      onchain_call_id: input.onchain_call_id.toLowerCase(),
      submit_tx_hash: input.submit_tx_hash.toLowerCase(),
      submit_log_index: input.submit_log_index,
      binary_index_ct_hash: input.binary_index_ct_hash.toLowerCase(),
      confidence_ct_hash: input.confidence_ct_hash.toLowerCase(),
      accepted_at: input.accepted_at,
      reveal_open_at: input.reveal_open_at,
      submission_class: 1,
      agent_wallet: input.expected_agent_wallet,
      market_id_hash: fhenixMarketIdForMurmurMarket(input.expected_market_id),
      client_nonce: "0x" + "09".repeat(32),
    };
  }

  async verifyVerdictRevealed(
    input: VerifyVerdictRevealedInput,
  ): Promise<VerifiedVerdictRevealed> {
    return {
      reveal_tx_hash: input.reveal_tx_hash.toLowerCase(),
      reveal_log_index: input.reveal_log_index,
      binary_index: input.binary_index,
      confidence_bps: input.confidence_bps,
      revealed_at: input.revealed_at,
      agent_wallet: input.expected_agent_wallet,
      market_id_hash: fhenixMarketIdForMurmurMarket(input.expected_market_id),
      onchain_call_id: input.onchain_call_id.toLowerCase(),
      reveal_sender: null,
    };
  }

  async verifyVerdictRevealInvalid(
    input: VerifyVerdictRevealInvalidInput,
  ): Promise<VerifiedVerdictRevealInvalid> {
    return {
      reveal_tx_hash: input.reveal_tx_hash.toLowerCase(),
      reveal_log_index: input.reveal_log_index,
      binary_index: input.binary_index,
      confidence_bps: input.confidence_bps,
      invalid_reason: input.invalid_reason,
      revealed_at: input.revealed_at,
      agent_wallet: input.expected_agent_wallet,
      market_id_hash: fhenixMarketIdForMurmurMarket(input.expected_market_id),
      onchain_call_id: input.onchain_call_id.toLowerCase(),
      reveal_sender: null,
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-fhenix-api-smoke-"));
const dbPath = join(tmp, "test.db");
let server: Server | null = null;

try {
  process.stdout.write("murmur fhenix api smoke\n");
  const db = openDb({ path: dbPath });
  const verifier = new SmokeFhenixVerifier();
  const adminToken = "admin-smoke-token";
  const acceptedAt = "2026-05-14T12:00:00Z";
  const revealOpenAt = "2026-05-14T13:00:00Z";
  const marketId = "0x" + "ab".repeat(32);
  const wallet = "0x1111111111111111111111111111111111111111";
  const agentId = randomUUID();
  const sealedCallIds = [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
    "00000000-0000-4000-8000-000000000303",
  ];
  const consumedSealedCallIds: string[] = [];
  const newSealedCallId = () => {
    const id = sealedCallIds.shift();
    assert.ok(id, "Sealed Call ID Adapter consumed too many IDs");
    consumedSealedCallIds.push(id);
    return id;
  };

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "fhenix-api-smoke",
    kind: "agent",
    display_name: "Fhenix API Smoke",
    created_at: acceptedAt,
    wallet_address: wallet,
    chain_id: "eip155:84532",
  });
  const account = getOrCreateAccount(db, {
    privy_user_id: "did:privy:fhenix-api-smoke",
    session_id: "smoke-session",
    expires_at: "2026-05-14T18:00:00Z",
  }, {
    resolvedAt: new Date(acceptedAt),
  });
  linkAgentToAccount(db, account.account_id, agentId, {
    linkedAt: new Date(acceptedAt),
  });
  bindControllerWallet(db, {
    account_id: account.account_id,
    agent_id: agentId,
    wallet_address: wallet,
    chain_id: "eip155:84532",
    wallet_kind: "embedded",
    provider: "smoke",
    binding_message: "smoke controller wallet binding",
    binding_signature: "0x" + "11".repeat(65),
    createdAt: new Date(acceptedAt),
  });

  marketsRepo.upsertExternalMarket(db, {
    market_id: marketId,
    asset_id: "polymarket:event",
    market_kind: "event_binary",
    horizon_seconds: 3600,
    primary_oracle_id: "polymarket-gamma-oracle",
    adapter_id: "polymarket-gamma",
    market_family: "prediction-market-binary",
    scoring_kind: "multinomial_brier",
    config_json: JSON.stringify({
      conditionId: marketId,
      slug: "fhenix-api-smoke-market",
      outcomes: ["Yes", "No"],
      endDate: revealOpenAt,
      gamma_url: "https://polymarket.com/event/fhenix-api-smoke-market",
    }),
    void_band: "0",
    status: "listed",
    created_at: acceptedAt,
  });

  const app = express();
  app.use(
    createVerdictRouter({
      db,
      adminToken,
      fhenixVerifier: verifier,
      newSealedCallId,
      now: () => new Date("2026-05-14T12:50:00Z"),
    }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminBackfill = (body: unknown) =>
    fetch(`${baseUrl}/v1/admin/fhenix/backfill/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": adminToken,
        "X-Murmur-Agent-Slug": "fhenix-api-smoke",
      },
      body: JSON.stringify(body),
    });

  const submitBody = {
    marketRef: {
      protocol: "polymarket-gamma",
      sourceId: marketId,
      configVersion: 1,
    },
    client_order_id: "fhenix-api-order-001",
    privacy_mode: "sealed_fhenix",
    fhenix: {
      chain_id: 84532,
      contract_address: "0x" + "22".repeat(20),
      onchain_call_id: "0x" + "33".repeat(32),
      submit_tx_hash: "0x" + "44".repeat(32),
      submit_log_index: 0,
      binary_index_ct_hash: "0x" + "55".repeat(32),
      confidence_ct_hash: "0x" + "66".repeat(32),
      accepted_at: acceptedAt,
      reveal_open_at: revealOpenAt,
      // NOTE: no submission_class here. It is decoded from the on-chain submit
      // event during verification, never supplied by the client — a caller
      // must not be able to claim its own call was sellable.
    },
    strategy_tag: "momentum",
  };

  let callId = "";
  let invalidCallId = "";

  await check("public sealed metadata backfill route is retired", async () => {
    const res = await fetch(`${baseUrl}/v2/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(submitBody),
    });
    assert.equal(res.status, 410);
    const body = await res.json() as { code: string; replacement: string };
    assert.equal(body.code, "endpoint_removed");
    assert.equal(body.replacement, "/v2/gateway/calls");
  });

  await check("submit rejects Fhenix event agent mismatch", async () => {
    verifier.mode = "agent_mismatch";
    const res = await adminBackfill(submitBody);
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string; context?: { fhenix_error?: string } };
    assert.equal(body.code, "schema_invalid");
    assert.equal(body.context?.fhenix_error, "event_mismatch");
  });

  await check("submit accepts only verified Fhenix event metadata", async () => {
    verifier.mode = "ok";
    const res = await adminBackfill(submitBody);
    assert.equal(res.status, 201);
    const body = await res.json() as {
      call_id: string;
      privacy_mode: string;
      commit_hash: string;
    };
    callId = body.call_id;
    assert.equal(callId, "00000000-0000-4000-8000-000000000301");
    assert.equal(body.privacy_mode, "sealed_fhenix");
    assert.match(body.commit_hash, /^[0-9a-f]{64}$/);
    const ctx = submissionsRepo.loadResolverContext(db, callId);
    assert.equal(ctx?.commitment_json, null);
    const sealed = db.prepare(
      "SELECT binary_index_ct_hash FROM fhenix_sealed_calls WHERE call_id = ?",
    ).get(callId) as { binary_index_ct_hash: string } | undefined;
    assert.equal(sealed?.binary_index_ct_hash, submitBody.fhenix.binary_index_ct_hash);
    assert.deepEqual(consumedSealedCallIds, [
      "00000000-0000-4000-8000-000000000301",
    ]);
  });

  await check("submit idempotent path does not consume Sealed Call IDs", async () => {
    const res = await adminBackfill(submitBody);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      call_id: string;
      idempotent_hit: boolean;
    };
    assert.equal(body.call_id, "00000000-0000-4000-8000-000000000301");
    assert.equal(body.idempotent_hit, true);
    assert.deepEqual(consumedSealedCallIds, [
      "00000000-0000-4000-8000-000000000301",
    ]);
  });

  await check("verified invalid reveal terminates without scoring commitment", async () => {
    const invalidSubmitBody = {
      ...submitBody,
      client_order_id: "fhenix-api-order-invalid-001",
      fhenix: {
        ...submitBody.fhenix,
        onchain_call_id: "0x" + "88".repeat(32),
        submit_tx_hash: "0x" + "89".repeat(32),
        binary_index_ct_hash: "0x" + "8a".repeat(32),
        confidence_ct_hash: "0x" + "8b".repeat(32),
        accepted_at: "2026-05-14T12:32:00Z",
      },
    };
    const submitRes = await adminBackfill(invalidSubmitBody);
    assert.equal(submitRes.status, 201);
    invalidCallId = ((await submitRes.json()) as { call_id: string }).call_id;
    assert.equal(invalidCallId, "00000000-0000-4000-8000-000000000302");
    assert.deepEqual(consumedSealedCallIds, [
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000302",
    ]);

    const revealRes = await fetch(`${baseUrl}/v1/admin/fhenix/invalid-reveals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        call_id: invalidCallId,
        binary_index: 2,
        confidence_bps: 7200,
        invalid_reason: "binary_index",
        revealed_at: revealOpenAt,
        reveal_tx_hash: "0x" + "8c".repeat(32),
        reveal_log_index: 2,
      }),
    });
    assert.equal(revealRes.status, 200);
    const ctx = submissionsRepo.loadResolverContext(db, invalidCallId);
    assert.equal(ctx?.status, "invalid_reveal");
    assert.equal(ctx?.commitment_json, null);
    const sealed = db.prepare(
      "SELECT reveal_status, invalid_reason FROM fhenix_sealed_calls WHERE call_id = ?",
    ).get(invalidCallId) as { reveal_status: string; invalid_reason: string } | undefined;
    assert.equal(sealed?.reveal_status, "invalid");
    assert.equal(sealed?.invalid_reason, "binary_index");
  });

  await check("resolver does not resurrect a call terminalized during an adapter observation", async () => {
    const raceMarketId = "0x" + "ef".repeat(32);
    marketsRepo.upsertExternalMarket(db, {
      market_id: raceMarketId,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: 3600,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      config_json: JSON.stringify({
        conditionId: raceMarketId,
        slug: "fhenix-api-smoke-race-market",
        outcomes: ["Yes", "No"],
        endDate: revealOpenAt,
        gamma_url: "https://polymarket.com/event/fhenix-api-smoke-race-market",
      }),
      void_band: "0",
      status: "listed",
      created_at: acceptedAt,
    });
    const raceCallId = randomUUID();
    submissionsRepo.acceptSealedFhenixCall(db, {
      call_id: raceCallId,
      agent_id: agentId,
      client_order_id: "fhenix-api-resolver-race",
      horizon_seconds: 3600,
      submitted_at: acceptedAt,
      accepted_at: acceptedAt,
      schema_version: 1,
      scoring_version: 1,
      dedup_key: `resolver-race-${raceCallId}`,
      commit_hash: "a".repeat(64),
      commit_scheme: "fhenix-sealed-v1",
      market_id: raceMarketId,
      market_config_version: 1,
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
    });
    submissionsRepo.attachRevealedCommitment(db, {
      call_id: raceCallId,
      commitment_json: JSON.stringify({
        marketRef: {
          protocol: "polymarket-gamma",
          sourceId: raceMarketId,
          configVersion: 1,
        },
        predictedOutcome: {
          kind: "binary",
          payoutNumerators: ["1", "0"],
          payoutDenominator: "1",
        },
        horizon: { iso: revealOpenAt, resolvesAfterMin: 60 },
        confidence: 0.72,
      }),
      predicted_outcome_json: JSON.stringify({ index: 0, label: "Yes" }),
      outcome_labels_json: JSON.stringify(["Yes", "No"]),
    });
    submissionsRepo.setStatus(db, raceCallId, "pending_t1");

    // Hold the venue read open so the reveal watcher can terminalize the call
    // mid-flight; the stale resolver context must not overwrite it.
    let releaseVenueRead!: () => void;
    const venueRead = new Promise<void>((resolve) => {
      releaseVenueRead = resolve;
    });
    let markVenueReadStarted!: () => void;
    const venueReadStarted = new Promise<void>((resolve) => {
      markVenueReadStarted = resolve;
    });
    const gammaClient = new PolymarketGammaClient({
      fetchFn: async () => {
        markVenueReadStarted();
        await venueRead;
        return {
          ok: true,
          status: 200,
          headers: { get: (_name: string) => "application/json" },
          text: async () =>
            JSON.stringify([
              {
                conditionId: raceMarketId,
                slug: "fhenix-api-smoke-race-market",
                outcomes: JSON.stringify(["Yes", "No"]),
                outcomePrices: JSON.stringify(["1", "0"]),
                umaResolutionStatus: "resolved",
                closed: true,
                active: false,
                archived: false,
                endDate: revealOpenAt,
                closedTime: revealOpenAt,
              },
            ]),
        };
      },
      maxRetries: 1,
      sleepMs: async () => undefined,
      nowMs: () => Date.parse("2026-05-14T12:01:00Z"),
    });
    setDefaultPolymarketClient(gammaClient);
    try {
      const raceNow = new Date("2026-05-14T12:01:00Z");
      const logs: unknown[] = [];
      const tick = new Resolver({
        db,
        now: () => raceNow,
        log: (event) => logs.push(event),
      }).tick();
      await venueReadStarted;
      submissionsRepo.setStatus(db, raceCallId, "invalid_reveal");
      releaseVenueRead();

      const result = await tick;
      assert.equal(
        submissionsRepo.loadResolverContext(db, raceCallId)?.status,
        "invalid_reveal",
      );
      assert.equal(resolutionsRepo.loadFullCall(db, raceCallId)?.resolution, null);
      assert.equal(result.resolved, 0, JSON.stringify(logs));
    } finally {
      setDefaultPolymarketClient(null);
    }
  });

  await check("verified reveal attaches public commitment and resolver score", async () => {
    const revealRes = await fetch(`${baseUrl}/v1/admin/fhenix/reveals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        call_id: callId,
        binary_index: 0,
        confidence_bps: 7200,
        revealed_at: revealOpenAt,
        reveal_tx_hash: "0x" + "77".repeat(32),
        reveal_log_index: 1,
      }),
    });
    assert.equal(revealRes.status, 200);
    const revealBody = await revealRes.json() as {
      revealed_verdict: { binary_index: number; confidence_bps: number };
    };
    assert.equal(revealBody.revealed_verdict.binary_index, 0);
    assert.equal(revealBody.revealed_verdict.confidence_bps, 7200);
    assert.ok(submissionsRepo.loadResolverContext(db, callId)?.commitment_json);

    const fetchFn = async () => ({
      ok: true,
      status: 200,
      headers: { get: (_name: string) => "application/json" },
      text: async () =>
        JSON.stringify([
          {
            conditionId: marketId,
            slug: "fhenix-api-smoke-market",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["1", "0"]),
            umaResolutionStatus: "resolved",
            umaResolutionStatuses: JSON.stringify(["proposed", "resolved"]),
            closed: true,
            active: false,
            archived: false,
            endDate: revealOpenAt,
            closedTime: revealOpenAt,
          },
        ]),
    });
    const client = new PolymarketGammaClient({
      fetchFn,
      maxRetries: 1,
      sleepMs: async () => undefined,
      nowMs: () => Date.parse("2026-05-14T14:00:00Z"),
    });
    setDefaultPolymarketClient(client);
    try {
      const logs: unknown[] = [];
      // No oracle dependency: the Resolver takes db + clock only.
      const resolver = new Resolver({
        db,
        now: () => new Date("2026-05-14T14:00:00Z"),
        log: (line) => logs.push(line),
      });
      const result = await resolver.tick();
      assert.equal(result.resolved, 1, JSON.stringify(logs));
      const full = resolutionsRepo.loadFullCall(db, callId);
      assert.equal(full?.submission.status, "resolved");
      assert.equal(full?.resolution?.outcome, "win");
      assert.equal(full?.resolution?.call_score, 1);
      // Murmur observes no prices: t1_feed / p1 / signed_return are legacy
      // columns and are always NULL (migration 055).
      assert.equal(full?.resolution?.t1_feed, null);
      assert.equal(full?.resolution?.p1, null);
      assert.equal(full?.resolution?.signed_return, null);
    } finally {
      setDefaultPolymarketClient(null);
    }
  });

  await check("Gamma-dropped micro-market resolves through the CLOB fallback", async () => {
    const clobMarketId = "0x" + "cd".repeat(32);
    marketsRepo.upsertExternalMarket(db, {
      market_id: clobMarketId,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: 3600,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      config_json: JSON.stringify({
        conditionId: clobMarketId,
        slug: "fhenix-api-smoke-clob-market",
        outcomes: ["Up", "Down"],
        clobTokenIds: { up: "111", down: "222" },
        endDate: revealOpenAt,
        gamma_url: "https://polymarket.com/event/fhenix-api-smoke-clob-market",
      }),
      void_band: "0",
      status: "listed",
      created_at: acceptedAt,
    });
    const clobSubmitBody = {
      ...submitBody,
      marketRef: { ...submitBody.marketRef, sourceId: clobMarketId },
      client_order_id: "fhenix-api-order-clob-001",
      fhenix: {
        ...submitBody.fhenix,
        onchain_call_id: "0x" + "9a".repeat(32),
        submit_tx_hash: "0x" + "9b".repeat(32),
        binary_index_ct_hash: "0x" + "9c".repeat(32),
        confidence_ct_hash: "0x" + "9d".repeat(32),
      },
    };
    const submitRes = await adminBackfill(clobSubmitBody);
    assert.equal(submitRes.status, 201);
    const clobCallId = ((await submitRes.json()) as { call_id: string }).call_id;
    assert.equal(clobCallId, "00000000-0000-4000-8000-000000000303");
    const revealRes = await fetch(`${baseUrl}/v1/admin/fhenix/reveals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        call_id: clobCallId,
        binary_index: 0,
        confidence_bps: 6100,
        revealed_at: revealOpenAt,
        reveal_tx_hash: "0x" + "9e".repeat(32),
        reveal_log_index: 3,
      }),
    });
    assert.equal(revealRes.status, 200);

    // Gamma serves `200 []` for the vanished micro-market (recorded as
    // http_404); the CLOB surface still has it, closed with one winner.
    const gammaClient = new PolymarketGammaClient({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: (_name: string) => "application/json" },
        text: async () => JSON.stringify([]),
      }),
      maxRetries: 1,
      sleepMs: async () => undefined,
      nowMs: () => Date.parse("2026-05-14T14:00:00Z"),
    });
    const clobClient = new PolymarketClobClient({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: (_name: string) => "application/json" },
        text: async () =>
          JSON.stringify({
            condition_id: clobMarketId,
            question: "Fhenix smoke - Up or Down",
            closed: true,
            archived: false,
            accepting_orders: false,
            is_50_50_outcome: false,
            tokens: [
              { token_id: "222", outcome: "DOWN", price: 0, winner: false },
              { token_id: "111", outcome: "UP", price: 1, winner: true },
            ],
          }),
      }),
      maxRetries: 1,
      sleepMs: async () => undefined,
      nowMs: () => Date.parse("2026-05-14T14:00:00Z"),
    });
    setDefaultPolymarketClient(gammaClient);
    setDefaultPolymarketClobClient(clobClient);
    try {
      const logs: unknown[] = [];
      // No oracle dependency: the Resolver takes db + clock only.
      const resolver = new Resolver({
        db,
        now: () => new Date("2026-05-14T14:00:00Z"),
        log: (line) => logs.push(line),
      });
      const result = await resolver.tick();
      assert.equal(result.resolved, 1, JSON.stringify(logs));
      const full = resolutionsRepo.loadFullCall(db, clobCallId);
      assert.equal(full?.submission.status, "resolved");
      assert.equal(full?.resolution?.outcome, "win");
      assert.equal(full?.resolution?.call_score, 1);
      const storedOutcome = JSON.parse(
        full?.resolution?.resolved_outcome_json ?? "null",
      ) as {
        kind: string;
        payoutNumerators: string[];
        evidence: { sourceProtocol: string; sourceId: string };
      } | null;
      assert.equal(storedOutcome?.kind, "binary");
      assert.deepEqual(storedOutcome?.payoutNumerators, ["1", "0"]);
      assert.equal(
        storedOutcome?.evidence.sourceProtocol,
        "polymarket-clob-fallback",
      );
      assert.equal(storedOutcome?.evidence.sourceId, clobMarketId);
    } finally {
      setDefaultPolymarketClient(null);
      setDefaultPolymarketClobClient(null);
    }
  });

  db.close();
} finally {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  }
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`fhenix api smoke failed: ${failures} failure(s)\n`);
  process.exit(1);
}

process.stdout.write("fhenix api smoke ok\n");
