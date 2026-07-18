import express from "express";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FhenixEventIngestor,
  FhenixEventIngestorConfigError,
  loadFhenixEventIngestorConfig,
} from "./fhenix-watcher.js";
import {
  fhenixMarketIdForMurmurMarket,
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
    };
  }
}

const tmp = mkdtempSync(join(tmpdir(), "murmur-fhenix-watcher-smoke-"));
const dbPath = join(tmp, "test.db");

try {
  process.stdout.write("murmur fhenix watcher smoke\n");
  const db = openDb({ path: dbPath });
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
      market_id: "eth.1h",
      market_config_version: 1,
      adapter_id: "native-price",
      market_family: "financial-direction",
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
      market_id: "eth.1h",
      market_config_version: 1,
      adapter_id: "native-price",
      market_family: "financial-direction",
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
      created_at: acceptedAt,
    });
    submissionsRepo.setStatus(db, callId, "pending_t1");
  }

  let logRead = 0;
  const client = {
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

  await check("watcher indexes reveal events and marks missed reveals", async () => {
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
    assert.equal(result.missed_reveals_marked, 1);

    const valid = fhenixSealedCallsRepo.byCallId(db, validCallId);
    assert.equal(valid?.reveal_status, "revealed");
    assert.equal(valid?.reveal_block_number, 8);
    assert.ok(submissionsRepo.loadResolverContext(db, validCallId)?.commitment_json);

    const missed = fhenixSealedCallsRepo.byCallId(db, missedCallId);
    assert.equal(missed?.reveal_status, "missed");
    assert.equal(submissionsRepo.loadResolverContext(db, missedCallId)?.status, "missed_reveal");
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
      assert.equal(body.counts?.missed, 1);
      assert.equal(body.queues?.terminal_failures, 1);
      assert.equal(body.queues?.needs_attention, 1);
      assert.ok(Array.isArray(body.cursors) && body.cursors.length > 0);
      assert.ok(Array.isArray(body.needs_attention) && body.needs_attention.length === 1);
    } finally {
      await closeServer(server);
    }
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
