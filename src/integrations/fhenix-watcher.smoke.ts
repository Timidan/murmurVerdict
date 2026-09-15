import type Database from "better-sqlite3";
import express from "express";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDeploymentByAddress } from "./deployments.js";
import {
  FhenixEventIngestor,
  FhenixEventIngestorChainMismatchError,
  FhenixEventIngestorConfigError,
  loadFhenixEventIngestorConfig,
} from "./fhenix-watcher.js";
import {
  fhenixMarketIdForMurmurMarket,
  VERDICT_REVEALED_EVENT,
  type FhenixEventVerifier,
  type VerifiedSealedCallSubmitted,
  type VerifiedVerdictRevealInvalid,
  type VerifiedVerdictRevealed,
  type VerifySealedCallSubmittedInput,
  type VerifyVerdictRevealInvalidInput,
  type VerifyVerdictRevealedInput,
} from "./fhenix-events.js";
import {
  agentsRepo,
  fhenixEventsRepo,
  fhenixSealedCallsRepo,
  marketsRepo,
  openDb,
  submissionsRepo,
} from "../verdict/db.js";
import { createVerdictRouter } from "../verdict/api.js";

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

class WatcherSmokeVerifier implements FhenixEventVerifier {
  async verifySealedCallSubmitted(
    input: VerifySealedCallSubmittedInput,
  ): Promise<VerifiedSealedCallSubmitted> {
    return {
      ...input,
      // Decoded from the submit event by the real verifier; never taken from
      // the caller's input.
      submission_class: 1,
      contract_address: input.contract_address.toLowerCase(),
      onchain_call_id: input.onchain_call_id.toLowerCase(),
      submit_tx_hash: input.submit_tx_hash.toLowerCase(),
      binary_index_ct_hash: input.binary_index_ct_hash.toLowerCase(),
      confidence_ct_hash: input.confidence_ct_hash.toLowerCase(),
      agent_wallet: input.expected_agent_wallet,
      market_id_hash: fhenixMarketIdForMurmurMarket(input.expected_market_id),
      client_nonce: "0x" + "01".repeat(32),
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

const tmp = mkdtempSync(join(tmpdir(), "murmur-fhenix-watcher-smoke-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur fhenix watcher smoke\n");
  const db = openDb({ path: dbPath });

  // Murmur ships no markets, so fixtures register their own external market.
  const WATCHER_MARKET_ID = `0x${"3f".repeat(32)}`;
  function seedWatcherMarket(target = db): void {
    marketsRepo.upsertExternalMarket(target, {
      market_id: WATCHER_MARKET_ID,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: 3600,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      config_json: JSON.stringify({
        conditionId: WATCHER_MARKET_ID,
        outcomes: ["Up", "Down"],
      }),
      void_band: "0",
      status: "listed",
      created_at: "2026-05-14T12:00:00Z",
    });
  }
  seedWatcherMarket();
  const verifier = new WatcherSmokeVerifier();
  const agentId = randomUUID();
  const wallet = "0x1111111111111111111111111111111111111111";
  const chainId = 84532;
  const contractAddress = "0x2222222222222222222222222222222222222222";
  const resolvedContractAddress = "0x3333333333333333333333333333333333333333";
  const replayContractAddress = "0x6666666666666666666666666666666666666666";
  const acceptedAt = "2026-05-14T12:00:00Z";
  const revealOpenAt = "2026-05-14T13:00:00Z";
  const validCallId = randomUUID();
  const missedCallId = randomUUID();
  const onchainValidCallId = "0x" + "33".repeat(32);
  const onchainMissedCallId = "0x" + "44".repeat(32);

  await check("ingestor config rejects malformed numeric env", () => {
    const baseEnv: NodeJS.ProcessEnv = {
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: String(chainId),
      FHENIX_SEALED_VERDICTS_ADDRESS: contractAddress,
    };
    assert.throws(
      () =>
        loadFhenixEventIngestorConfig({
          ...baseEnv,
          FHENIX_CHAIN_ID: "not-a-chain",
        }),
      (err) =>
        err instanceof FhenixEventIngestorConfigError &&
        err.key === "FHENIX_CHAIN_ID",
    );
    assert.throws(
      () =>
        loadFhenixEventIngestorConfig({
          ...baseEnv,
          FHENIX_EVENT_BATCH_SIZE: "0",
        }),
      (err) =>
        err instanceof FhenixEventIngestorConfigError &&
        err.key === "FHENIX_EVENT_BATCH_SIZE",
    );
    assert.throws(
      () =>
        loadFhenixEventIngestorConfig({
          ...baseEnv,
          FHENIX_EVENT_CONFIRMATIONS: "-1",
        }),
      (err) =>
        err instanceof FhenixEventIngestorConfigError &&
        err.key === "FHENIX_EVENT_CONFIRMATIONS",
    );

    const parsed = loadFhenixEventIngestorConfig({
      ...baseEnv,
      FHENIX_EVENT_BATCH_SIZE: "10000",
      FHENIX_REVEAL_GRACE_SEC: "0",
    });
    assert.equal(parsed?.batchSize, 10_000);
    assert.equal(parsed?.revealGraceSeconds, 0);

    const parsedWithResolvedAddress = loadFhenixEventIngestorConfig({
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: String(chainId),
    }, {
      contractAddress: resolvedContractAddress,
    });
    assert.equal(
      parsedWithResolvedAddress?.contractAddress,
      resolvedContractAddress,
    );
    assert.equal(
      loadFhenixEventIngestorConfig(baseEnv, { contractAddress: null }),
      null,
    );
    assert.throws(
      () =>
        loadFhenixEventIngestorConfig({
          FHENIX_RPC_URL: "http://127.0.0.1:8545",
          FHENIX_CHAIN_ID: String(chainId),
        }, {
          contractAddress: "not-an-address",
        }),
      (err) =>
        err instanceof FhenixEventIngestorConfigError &&
        err.key === "FHENIX_SEALED_VERDICTS_ADDRESS",
    );
  });

  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "fhenix-watcher-smoke",
    kind: "agent",
    display_name: "Fhenix Watcher Smoke",
    created_at: acceptedAt,
    wallet_address: wallet,
    chain_id: `eip155:${chainId}`,
  });

  await check("watcher replays an indexed reveal after its local call arrives", async () => {
    const replayCallId = randomUUID();
    const onchainReplayCallId = "0x" + "66".repeat(32);
    let replayLogRead = 0;
    const replayClient = {
      getChainId: async () => chainId,
      getBlockNumber: async () => 10n,
      getLogs: async () => {
        replayLogRead += 1;
        if (replayLogRead !== 1) return [];
        return [
          {
            args: {
              callId: onchainReplayCallId,
              binaryIndex: 1,
              confidenceBps: 8100,
              revealedAt: BigInt(Date.parse(revealOpenAt) / 1000),
            },
            transactionHash: "0x" + "99".repeat(32),
            logIndex: 2,
            blockNumber: 8n,
            blockHash: "0x" + "aa".repeat(32),
          },
        ];
      },
    };
    const watcher = new FhenixEventIngestor({
      db,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: replayContractAddress,
      startBlock: 1,
      confirmations: 0,
      revealGraceSeconds: 1,
      client: replayClient as never,
      now: () => new Date("2026-05-14T14:00:00Z"),
    });

    const indexedBeforeLocalCall = await watcher.tick();
    assert.equal(indexedBeforeLocalCall.indexed, 1);
    assert.equal(indexedBeforeLocalCall.valid_reveals_attached, 0);
    assert.equal(fhenixEventsRepo.getCursor(db, {
      chain_id: chainId,
      contract_address: replayContractAddress,
      event_name: "VerdictRevealed",
    }), 10);

    submissionsRepo.acceptSealedFhenixCall(db, {
      call_id: replayCallId,
      agent_id: agentId,
      client_order_id: "watcher-order-replay",
      horizon_seconds: 3600,
      submitted_at: acceptedAt,
      accepted_at: acceptedAt,
      rationale: null,
      strategy_tag: "momentum",
      schema_version: 1,
      scoring_version: 1,
      dedup_key: "watcher-order-replay:dedup",
      commit_hash: "0x" + "66".repeat(32),
      commit_scheme: "fhenix-sealed-v1",
      market_id: WATCHER_MARKET_ID,
      market_config_version: 1,
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
    });
    fhenixSealedCallsRepo.insert(db, {
      call_id: replayCallId,
      chain_id: chainId,
      contract_address: replayContractAddress,
      onchain_call_id: onchainReplayCallId,
      submit_tx_hash: "0x" + "66".repeat(32),
      submit_log_index: 0,
      binary_index_ct_hash: "0x" + "66".repeat(32),
      confidence_ct_hash: "0x" + "66".repeat(32),
      reveal_open_at: revealOpenAt,
      submission_class: 1,
      created_at: acceptedAt,
    });
    submissionsRepo.setStatus(db, replayCallId, "pending_t1");

    const replayedAfterLocalCall = await watcher.tick();
    assert.equal(replayedAfterLocalCall.indexed, 0);
    assert.equal(replayedAfterLocalCall.valid_reveals_attached, 1);
    const replayed = fhenixSealedCallsRepo.byCallId(db, replayCallId);
    assert.equal(replayed?.reveal_status, "revealed");
    assert.equal(replayed?.reveal_tx_hash, "0x" + "99".repeat(32));
  });

  for (const [callId, onchainCallId, order, hexByte] of [
    [validCallId, onchainValidCallId, "watcher-order-valid", "11"],
    [missedCallId, onchainMissedCallId, "watcher-order-missed", "22"],
  ] as const) {
    submissionsRepo.acceptSealedFhenixCall(db, {
      call_id: callId,
      agent_id: agentId,
      client_order_id: order,
      horizon_seconds: 3600,
      submitted_at: acceptedAt,
      accepted_at: acceptedAt,
      rationale: null,
      strategy_tag: "momentum",
      schema_version: 1,
      scoring_version: 1,
      dedup_key: `${order}:dedup`,
      commit_hash: "0x" + hexByte.repeat(32),
      commit_scheme: "fhenix-sealed-v1",
      market_id: WATCHER_MARKET_ID,
      market_config_version: 1,
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
    });
    fhenixSealedCallsRepo.insert(db, {
      call_id: callId,
      chain_id: chainId,
      contract_address: contractAddress,
      onchain_call_id: onchainCallId,
      submit_tx_hash: "0x" + hexByte.repeat(32),
      submit_log_index: 0,
      binary_index_ct_hash: "0x" + hexByte.repeat(32),
      confidence_ct_hash: "0x" + hexByte.repeat(32),
      reveal_open_at: revealOpenAt,
      submission_class: 1,
      created_at: acceptedAt,
    });
    submissionsRepo.setStatus(db, callId, "pending_t1");
  }

  let logRead = 0;
  const client = {
    getChainId: async () => chainId,
    getBlockNumber: async () => 10n,
    getLogs: async () => {
      logRead += 1;
      if (logRead !== 1) return [];
      return [
        {
          args: {
            callId: onchainValidCallId,
            binaryIndex: 0,
            confidenceBps: 7200,
            revealedAt: BigInt(Date.parse(revealOpenAt) / 1000),
          },
          transactionHash: "0x" + "77".repeat(32),
          logIndex: 1,
          blockNumber: 8n,
          blockHash: "0x" + "88".repeat(32),
        },
      ];
    },
  };

  await check("watcher indexes reveal events and NO LONGER auto-marks missed reveals", async () => {
    const watcher = new FhenixEventIngestor({
      db,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress,
      startBlock: 1,
      confirmations: 0,
      revealGraceSeconds: 1,
      client: client as never,
      now: () => new Date("2026-05-14T14:00:00Z"),
    });
    const result = await watcher.tick();
    assert.equal(result.indexed, 1);
    assert.equal(result.valid_reveals_attached, 1);
    // The watcher never auto-marks `missed`.
    assert.equal(result.missed_reveals_marked, 0);

    const valid = fhenixSealedCallsRepo.byCallId(db, validCallId);
    assert.equal(valid?.reveal_status, "revealed");
    assert.equal(valid?.reveal_block_number, 8);
    assert.ok(submissionsRepo.loadResolverContext(db, validCallId)?.commitment_json);

    // The overdue, unrevealed call stays PENDING (never auto-missed).
    const stillPending = fhenixSealedCallsRepo.byCallId(db, missedCallId);
    assert.equal(stillPending?.reveal_status, "pending");
    assert.notEqual(
      submissionsRepo.loadResolverContext(db, missedCallId)?.status,
      "missed_reveal",
    );
  });

  await check("admin lifecycle snapshot exposes reveal monitoring state", async () => {
    const app = express();
    app.use(createVerdictRouter({
      db,
      adminToken: "admin-token",
      fhenixVerifier: null,
      now: () => new Date("2026-05-14T14:00:00Z"),
    }));
    const { server, port } = await listen(app);
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const denied = await fetch(`${baseUrl}/v1/admin/fhenix/lifecycle`);
      assert.equal(denied.status, 403);

      const res = await fetch(`${baseUrl}/v1/admin/fhenix/lifecycle`, {
        headers: { "X-Admin-Token": "admin-token" },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        counts?: { revealed?: number; missed?: number };
        queues?: { terminal_failures?: number; needs_attention?: number };
        cursors?: unknown[];
        needs_attention?: unknown[];
      };
      assert.equal(body.counts?.revealed, 2);
      // The overdue call stays `pending` and shows in needs_attention, not as `missed`.
      assert.equal(body.counts?.missed ?? 0, 0);
      assert.equal(body.queues?.terminal_failures, 0);
      assert.equal(body.queues?.needs_attention, 1);
      assert.ok(Array.isArray(body.cursors) && body.cursors.length > 0);
      assert.ok(Array.isArray(body.needs_attention) && body.needs_attention.length === 1);
    } finally {
      await closeServer(server);
    }
  });

  // ── Watcher start-block / catch-up / gating cases ──────────────────────────
  const newDb = (): Database.Database =>
    openDb({ path: join(tmp, `watcher-${randomUUID()}.db`) });
  const seedAgentInto = (target: Database.Database): void => {
    // Isolated per-case databases need the external market too.
    seedWatcherMarket(target);
    agentsRepo.insert(target, {
      agent_id: agentId,
      display_slug: "fhenix-watcher-smoke",
      kind: "agent",
      display_name: "Fhenix Watcher Smoke",
      created_at: acceptedAt,
      wallet_address: wallet,
      chain_id: `eip155:${chainId}`,
    });
  };
  const seedPendingCallInto = (
    target: Database.Database,
    params: {
      callId: string;
      onchainCallId: string;
      contractAddress: string;
      order: string;
      hexByte: string;
    },
  ): void => {
    submissionsRepo.acceptSealedFhenixCall(target, {
      call_id: params.callId,
      agent_id: agentId,
      client_order_id: params.order,
      horizon_seconds: 3600,
      submitted_at: acceptedAt,
      accepted_at: acceptedAt,
      rationale: null,
      strategy_tag: "momentum",
      schema_version: 1,
      scoring_version: 1,
      dedup_key: `${params.order}:dedup`,
      commit_hash: "0x" + params.hexByte.repeat(32),
      commit_scheme: "fhenix-sealed-v1",
      market_id: WATCHER_MARKET_ID,
      market_config_version: 1,
      adapter_id: "polymarket-gamma",
      market_family: "prediction-market-binary",
    });
    fhenixSealedCallsRepo.insert(target, {
      call_id: params.callId,
      chain_id: chainId,
      contract_address: params.contractAddress,
      onchain_call_id: params.onchainCallId,
      submit_tx_hash: "0x" + params.hexByte.repeat(32),
      submit_log_index: 0,
      binary_index_ct_hash: "0x" + params.hexByte.repeat(32),
      confidence_ct_hash: "0x" + params.hexByte.repeat(32),
      reveal_open_at: revealOpenAt,
      submission_class: 1,
      created_at: acceptedAt,
    });
    submissionsRepo.setStatus(target, params.callId, "pending_t1");
  };
  const readCursor = (
    target: Database.Database,
    contract: string,
    eventName: "VerdictRevealed" | "VerdictRevealInvalid",
  ): number | null =>
    fhenixEventsRepo.getCursor(target, {
      chain_id: chainId,
      contract_address: contract,
      event_name: eventName,
    });
  const fixedNow = () => new Date("2026-05-14T14:00:00Z");
  const idleClient = (over: Record<string, unknown>) => ({
    getChainId: async () => chainId,
    getBlock: async () => ({ timestamp: 0n }),
    ...over,
  });

  await check("watcher config derives start block from the address-matched manifest entry", () => {
    const manifest = join(tmp, "deployments-derive.json");
    const sealedAddr = "0x1b74a4bab1e06ed107780a245c85337ab9decd1a";
    writeFileSync(
      manifest,
      JSON.stringify([
        {
          chainId,
          contractName: "MurmurSealedVerdicts",
          address: sealedAddr,
          deployedAt: "2026-05-23T04:09:59.226Z",
          txHash: "0x" + "ab".repeat(32),
          blockNumber: 41870556,
        },
      ]),
    );
    const cfg = loadFhenixEventIngestorConfig({
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: String(chainId),
      FHENIX_SEALED_VERDICTS_ADDRESS: sealedAddr,
      DEPLOYMENTS_MANIFEST_PATH: manifest,
    });
    assert.equal(cfg?.startBlock, 41870556);
    assert.equal(cfg?.watcherRpcUrl, "http://127.0.0.1:8545");

    // FHENIX_EVENT_START_BLOCK is ignored; the manifest is the only source.
    const ignoredOverride = loadFhenixEventIngestorConfig({
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: String(chainId),
      FHENIX_SEALED_VERDICTS_ADDRESS: sealedAddr,
      DEPLOYMENTS_MANIFEST_PATH: manifest,
      FHENIX_EVENT_START_BLOCK: "50000000",
      FHENIX_WATCHER_RPC_URL: "http://127.0.0.1:9999",
    });
    assert.equal(
      ignoredOverride?.startBlock,
      41870556,
      "the manifest block wins; a stale env override is ignored",
    );
    assert.equal(ignoredOverride?.watcherRpcUrl, "http://127.0.0.1:9999");
  });

  await check("older-address override picks the matching block, not the latest-by-name", () => {
    const manifest = join(tmp, "deployments-two.json");
    const newer = "0x1b74a4bab1e06ed107780a245c85337ab9decd1a";
    const older = "0xe2ee519bfa5e8fcd8b6d6339b123968e23bc00f7";
    writeFileSync(
      manifest,
      JSON.stringify([
        {
          chainId,
          contractName: "MurmurSealedVerdicts",
          address: newer,
          deployedAt: "2026-05-23T04:09:59.226Z",
          txHash: "0x" + "11".repeat(32),
          blockNumber: 41870556,
        },
        {
          chainId,
          contractName: "MurmurSealedVerdicts",
          address: older,
          deployedAt: "2026-05-17T16:55:40.935Z",
          txHash: "0x" + "22".repeat(32),
          blockNumber: 41634327,
        },
      ]),
    );
    assert.equal(
      loadDeploymentByAddress(chainId, "MurmurSealedVerdicts", older, manifest)?.blockNumber,
      41634327,
    );
    assert.equal(
      loadDeploymentByAddress(chainId, "MurmurSealedVerdicts", newer, manifest)?.blockNumber,
      41870556,
    );
    assert.equal(
      loadDeploymentByAddress(chainId, "MurmurSealedVerdicts", "0x" + "00".repeat(20), manifest),
      null,
    );
    // Config resolves against the OLDER address → older block, even though the
    // newer entry is latest-by-name.
    const cfg = loadFhenixEventIngestorConfig({
      FHENIX_RPC_URL: "http://127.0.0.1:8545",
      FHENIX_CHAIN_ID: String(chainId),
      FHENIX_SEALED_VERDICTS_ADDRESS: older,
      DEPLOYMENTS_MANIFEST_PATH: manifest,
    });
    assert.equal(cfg?.startBlock, 41634327);
  });

  await check("stale low cursor jumps forward to the derived start block", async () => {
    const db3 = newDb();
    const contract = "0x7777777777777777777777777777777777777777";
    const froms: number[] = [];
    fhenixEventsRepo.setCursor(db3, {
      chain_id: chainId,
      contract_address: contract,
      event_name: "VerdictRevealed",
      last_block_number: 10,
      updated_at: acceptedAt,
    });
    const watcher = new FhenixEventIngestor({
      db: db3,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 5000,
      confirmations: 0,
      batchSize: 1000,
      maxBatchesPerTick: 1,
      revealGraceSeconds: 1,
      client: idleClient({
        getBlockNumber: async () => 6000n,
        getLogs: async (a: { fromBlock: bigint }) => {
          froms.push(Number(a.fromBlock));
          return [];
        },
      }) as never,
      now: fixedNow,
    });
    await watcher.tick();
    assert.ok(
      froms.length > 0 && froms.every((f) => f >= 5000),
      `expected all getLogs fromBlock >= 5000, saw ${froms.join(",")}`,
    );
    assert.equal(readCursor(db3, contract, "VerdictRevealed"), 5999);
    db3.close();
  });

  await check("catch-up processes multiple batches in a single tick", async () => {
    const db4 = newDb();
    const contract = "0x8888888888888888888888888888888888888888";
    let calls = 0;
    const watcher = new FhenixEventIngestor({
      db: db4,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 1000,
      maxBatchesPerTick: 50,
      revealGraceSeconds: 1,
      client: idleClient({
        getBlockNumber: async () => 3500n,
        getLogs: async () => {
          calls += 1;
          return [];
        },
      }) as never,
      now: fixedNow,
    });
    await watcher.tick();
    assert.equal(readCursor(db4, contract, "VerdictRevealed"), 3500);
    assert.equal(readCursor(db4, contract, "VerdictRevealInvalid"), 3500);
    // 4 batches per stream (1-1000..3001-3500) x 2 streams.
    assert.equal(calls, 8);
    db4.close();
  });

  await check("getLogs halves and retries on a range-limit error", async () => {
    const db5 = newDb();
    const contract = "0x9999999999999999999999999999999999999999";
    let calls = 0;
    const watcher = new FhenixEventIngestor({
      db: db5,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 1000,
      maxBatchesPerTick: 50,
      revealGraceSeconds: 1,
      client: idleClient({
        getBlockNumber: async () => 1000n,
        getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
          calls += 1;
          const width = Number(a.toBlock) - Number(a.fromBlock) + 1;
          if (width > 500) {
            const err = new Error(
              "query exceeded max results; response size too large",
            ) as Error & { code?: number };
            err.code = -32701;
            throw err;
          }
          return [];
        },
      }) as never,
      now: fixedNow,
    });
    await watcher.tick();
    assert.equal(readCursor(db5, contract, "VerdictRevealed"), 1000);
    // per stream: full range (throws) + 2 halves = 3 calls; x2 streams.
    assert.equal(calls, 6);
    db5.close();
  });

  await check("getLogs does NOT halve on a bare -32602 archive rejection", async () => {
    const db6 = newDb();
    const contract = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let calls = 0;
    const watcher = new FhenixEventIngestor({
      db: db6,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 1000,
      maxBatchesPerTick: 50,
      revealGraceSeconds: 1,
      client: idleClient({
        getBlockNumber: async () => 1000n,
        getLogs: async () => {
          calls += 1;
          const err = new Error(
            "Archive requests require a personal token",
          ) as Error & { code?: number };
          err.code = -32602;
          throw err;
        },
      }) as never,
      now: fixedNow,
    });
    // Scan error is swallowed (tick resolves), but the cursor must not advance
    // and the range must not be halved.
    await watcher.tick();
    assert.equal(calls, 2); // one failed getLogs per stream, no halving
    assert.equal(readCursor(db6, contract, "VerdictRevealed"), null);
    assert.equal(readCursor(db6, contract, "VerdictRevealInvalid"), null);
    db6.close();
  });

  await check("wrong-chain RPC aborts the tick without advancing cursors", async () => {
    const db7 = newDb();
    const contract = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let getLogsCalls = 0;
    fhenixEventsRepo.setCursor(db7, {
      chain_id: chainId,
      contract_address: contract,
      event_name: "VerdictRevealed",
      last_block_number: 123,
      updated_at: acceptedAt,
    });
    const watcher = new FhenixEventIngestor({
      db: db7,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 1000,
      revealGraceSeconds: 1,
      client: idleClient({
        getChainId: async () => 1,
        getBlockNumber: async () => 1000n,
        getLogs: async () => {
          getLogsCalls += 1;
          return [];
        },
      }) as never,
      now: fixedNow,
    });
    await assert.rejects(
      () => watcher.tick(),
      (err) =>
        err instanceof FhenixEventIngestorChainMismatchError &&
        err.actualChainId === 1 &&
        err.expectedChainId === chainId,
    );
    assert.equal(getLogsCalls, 0);
    assert.equal(readCursor(db7, contract, "VerdictRevealed"), 123);
    db7.close();
  });

  await check("cursor ahead of head is reported and is a no-op", async () => {
    const db8 = newDb();
    const contract = "0xcccccccccccccccccccccccccccccccccccccccc";
    let getLogsCalls = 0;
    const lines: string[] = [];
    for (const eventName of ["VerdictRevealed", "VerdictRevealInvalid"] as const) {
      fhenixEventsRepo.setCursor(db8, {
        chain_id: chainId,
        contract_address: contract,
        event_name: eventName,
        last_block_number: 5000,
        updated_at: acceptedAt,
      });
    }
    const watcher = new FhenixEventIngestor({
      db: db8,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 1000,
      revealGraceSeconds: 1,
      client: idleClient({
        getBlockNumber: async () => 1000n,
        getLogs: async () => {
          getLogsCalls += 1;
          return [];
        },
      }) as never,
      now: fixedNow,
      log: (line) => lines.push(line),
    });
    const result = await watcher.tick();
    assert.equal(getLogsCalls, 0);
    assert.equal(result.indexed, 0);
    assert.equal(readCursor(db8, contract, "VerdictRevealed"), 5000);
    assert.ok(
      lines.some((line) => /ahead of safe head/.test(line)),
      "expected a cursor-ahead-of-head report line",
    );
    db8.close();
  });

  await check("a reveal in a later unscanned batch is NOT marked missed mid catch-up", async () => {
    const db9 = newDb();
    seedAgentInto(db9);
    const contract = "0xdddddddddddddddddddddddddddddddddddddddd";
    const callId = randomUUID();
    const onchain = "0x" + "d1".repeat(32);
    seedPendingCallInto(db9, {
      callId,
      onchainCallId: onchain,
      contractAddress: contract,
      order: "watcher-order-latebatch",
      hexByte: "d1",
    });
    const revealBlock = 3000;
    const watcher = new FhenixEventIngestor({
      db: db9,
      verifier,
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      contractAddress: contract,
      startBlock: 1,
      confirmations: 0,
      batchSize: 1000,
      maxBatchesPerTick: 1, // one batch/tick so catch-up spans several ticks
      revealGraceSeconds: 1,
      client: idleClient({
        getBlockNumber: async () => 3000n,
        // Safe-block time is past the reveal deadline: a partial-scan bug would
        // wrongly mark the overdue call missed.
        getBlock: async () => ({
          timestamp: BigInt(Math.floor(Date.parse("2026-05-14T14:00:00Z") / 1000)),
        }),
        getLogs: async (a: {
          event: typeof VERDICT_REVEALED_EVENT;
          fromBlock: bigint;
          toBlock: bigint;
        }) => {
          const from = Number(a.fromBlock);
          const to = Number(a.toBlock);
          if (a.event === VERDICT_REVEALED_EVENT && from <= revealBlock && revealBlock <= to) {
            return [
              {
                args: {
                  callId: onchain,
                  binaryIndex: 1,
                  confidenceBps: 8100,
                  revealedAt: BigInt(Date.parse(revealOpenAt) / 1000),
                },
                transactionHash: "0x" + "d2".repeat(32),
                logIndex: 0,
                blockNumber: BigInt(revealBlock),
                blockHash: "0x" + "d3".repeat(32),
              },
            ];
          }
          return [];
        },
      }) as never,
      now: fixedNow,
    });

    // Ticks 1-2 only reach blocks 1000 then 2000 — the reveal at 3000 has not
    // been scanned, so the overdue call must stay pending, never `missed`.
    for (let i = 0; i < 2; i += 1) {
      const r = await watcher.tick();
      assert.equal(
        r.missed_reveals_marked,
        0,
        `tick ${i + 1} must not terminalize as missed mid catch-up`,
      );
      assert.equal(
        fhenixSealedCallsRepo.byCallId(db9, callId)?.reveal_status,
        "pending",
        `tick ${i + 1} must leave the call pending`,
      );
    }

    // Tick 3 scans 2001-3000, ingests the reveal, and reaches head.
    const r3 = await watcher.tick();
    assert.equal(r3.valid_reveals_attached, 1);
    assert.equal(r3.missed_reveals_marked, 0);
    assert.equal(fhenixSealedCallsRepo.byCallId(db9, callId)?.reveal_status, "revealed");
    db9.close();
  });

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  process.stdout.write(`fhenix watcher smoke failed: ${failures} failure(s)\n`);
  process.exit(1);
}

process.stdout.write("fhenix watcher smoke ok\n");

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        reject(new Error("server did not bind tcp address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
