// ─── fhenix-gateway-race.smoke.ts ─────────────────────────────────────────
// Two connections on one file-backed DB exercise the claim-token race:
//   1. Two connections claim the same attempt → exactly one wins.
//   2. The loser sees the row as claimed via plain byId reads.
//   3. markSubmitted releases the token atomically with the status flip.
//   4. sweepStuckClaims returns stale claims to failed_retryable.
// WAL allows one writer; the conditional UPDATE never grants two claims.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  encodeAbiParameters,
  padHex,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

import {
  FEED_PACKET_SUBMITTED_TOPIC,
  SEALED_CALL_SUBMITTED_TOPIC,
} from "./fhenix-event-primitives.js";

import {
  fhenixGatewayFeedPacketTxRepo,
  fhenixGatewayTxRepo,
  openDb,
  type FhenixGatewayFeedPacketTxAttemptInsert,
  type FhenixGatewayTxAttemptInsert,
} from "../verdict/db.js";
import { broadcastGatewayAttempt } from "./fhenix-gateway-attempt-machine.js";
import {
  engageAccountKillSwitch,
  releaseAccountKillSwitch,
} from "../verdict/auth/account-kill-switch.js";
import {
  feedPacketAttemptKind,
  sealedCallAttemptKind,
} from "./fhenix-gateway-attempt-kinds.js";
import type {
  FhenixGatewayClient,
  GatewayGetLogsArgs,
  GatewayLog,
  GatewayReadContractArgs,
  GatewayWriteContractArgs,
} from "./fhenix-gateway-contract.js";
import {
  computeFeedPacketId,
  computeSealedCallId,
} from "./fhenix-gateway-contract-ids.js";

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(
    () => console.log(`  ok ${name}`),
    (err) => {
      console.error(`  FAIL ${name}\n    ${(err as Error).message}`);
      process.exitCode = 1;
      throw err;
    },
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoMinus(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

async function main(): Promise<void> {
  console.log("murmur fhenix gateway race smoke");

  const dir = mkdtempSync(join(tmpdir(), "murmur-race-"));
  const dbPath = join(dir, "race.db");

  const dbA = openDb({ path: dbPath });
  const dbB = openDb({ path: dbPath });

  try {
    // ── Bootstrap minimal FK rows ────────────────────────────────────
    // Only enough rows to satisfy the attempt table's FKs.
    const accountId = randomUUID();
    const agentId = randomUUID();
    const ts = nowIso();
    dbA.prepare(
      `INSERT INTO accounts (account_id, privy_user_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)`,
    ).run(accountId, "did:privy:race-test", ts, ts);
    dbA.prepare(
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash, wallet_address, chain_id)
       VALUES (?, ?, 'agent', ?, NULL, ?, NULL, NULL, NULL)`,
    ).run(agentId, "race-test-agent", "Race Test Agent", ts);
    dbA.prepare(
      `INSERT INTO account_agents (account_id, agent_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(accountId, agentId, ts);

    function makeAttempt(suffix: string): FhenixGatewayTxAttemptInsert {
      // Unique client_nonce (UNIQUE on chain/contract/agent/market/client_nonce).
      const nonceSeed = (suffix + randomUUID()).replace(/-/g, "").padEnd(64, "0").slice(0, 64);
      return {
        attempt_id: randomUUID(),
        status: "queued",
        request_fingerprint: null,
        auth_proof: null,
        runtime_key_id: null,
        runtime_key_policy_hash: "0x" + "00".repeat(32),
        runtime_key_policy_json: "{}",
        account_id: accountId,
        agent_id: agentId,
        chain_id: 84532,
        contract_address: "0x" + "11".repeat(20),
        relayer_address: "0x" + "22".repeat(20),
        agent_wallet_address: "0x" + "33".repeat(20),
        market_id: "race-market",
        market_id_hash: "0x" + "44".repeat(32),
        market_ref_protocol: "polymarket-gamma",
        market_config_version: 1,
        client_order_id: `race-order-${suffix}`,
        client_nonce: "0x" + nonceSeed,
        submitted_at: ts,
        rationale: null,
        strategy_tag: null,
        binary_index_input_json: "{}",
        confidence_input_json: "{}",
        binary_index_ct_hash: `0x${nonceSeed}`,
        confidence_ct_hash: `0x${nonceSeed.slice(0, 63)}1`,
        next_attempt_at: ts,
        created_at: ts,
        updated_at: ts,
      };
    }

    // ── 1. Concurrent claim: exactly one winner ─────────────────────
    await check("two connections claim same attempt — exactly one wins", () => {
      const attempt = makeAttempt("concurrent");
      fhenixGatewayTxRepo.insert(dbA, attempt);

      const tokenA = randomUUID();
      const tokenB = randomUUID();
      const startedAt = nowIso();

      // Not a true race in one process, but the same conditional UPDATE
      // (`broadcast_claim_token IS NULL`) arbitrates between processes.
      const wonA = fhenixGatewayTxRepo.claimForBroadcast(dbA, {
        attempt_id: attempt.attempt_id,
        broadcast_started_at: startedAt,
        updated_at: startedAt,
        token: tokenA,
      });
      const wonB = fhenixGatewayTxRepo.claimForBroadcast(dbB, {
        attempt_id: attempt.attempt_id,
        broadcast_started_at: startedAt,
        updated_at: startedAt,
        token: tokenB,
      });

      assert.equal(wonA, true, "dbA should win the claim");
      assert.equal(wonB, false, "dbB should observe the existing claim");

      // Both connections see the same winning token after the commit.
      const seenByA = fhenixGatewayTxRepo.byId(dbA, attempt.attempt_id);
      const seenByB = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      assert.equal(seenByA?.broadcast_claim_token, tokenA);
      assert.equal(seenByB?.broadcast_claim_token, tokenA);
    });

    // ── 2. markSubmitted releases the claim ─────────────────────────
    await check("markSubmitted clears broadcast_claim_token", () => {
      const attempt = makeAttempt("submitted");
      fhenixGatewayTxRepo.insert(dbA, attempt);
      const startedAt = nowIso();
      assert.equal(
        fhenixGatewayTxRepo.claimForBroadcast(dbA, {
          attempt_id: attempt.attempt_id,
          broadcast_started_at: startedAt,
          updated_at: startedAt,
          token: randomUUID(),
        }),
        true,
      );
      fhenixGatewayTxRepo.markSubmitted(dbA, {
        attempt_id: attempt.attempt_id,
        tx_hash: "0x" + "ab".repeat(32),
        next_attempt_at: nowIso(),
        updated_at: nowIso(),
        broadcast_started_at: startedAt,
        broadcast_latency_ms: 42,
      });
      const after = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      assert.equal(after?.status, "submitted");
      assert.equal(after?.broadcast_claim_token, null);
    });

    // ── 3. sweepStuckClaims recovers crashed claimants ──────────────
    await check("sweepStuckClaims resets stale claims back to failed_retryable", () => {
      const attempt = makeAttempt("stuck");
      fhenixGatewayTxRepo.insert(dbA, attempt);
      // Raw SQL: stamp a stale claim from a simulated crashed process.
      const staleStart = isoMinus(600 * 2);
      dbA
        .prepare(
          `UPDATE fhenix_gateway_tx_attempts
           SET broadcast_claim_token = ?,
               broadcast_started_at = ?,
               updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(randomUUID(), staleStart, nowIso(), attempt.attempt_id);

      const before = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      assert.notEqual(before?.broadcast_claim_token, null);

      const released = fhenixGatewayTxRepo.sweepStuckClaims(dbB, {
        stuckBeforeIso: isoMinus(600),
        updated_at: nowIso(),
        errorMessage: "test sweep",
      });
      assert.equal(released, 1);

      const after = fhenixGatewayTxRepo.byId(dbA, attempt.attempt_id);
      assert.equal(after?.broadcast_claim_token, null);
      assert.equal(after?.status, "failed_retryable");
      assert.equal(after?.last_error, "test sweep");
    });

    // ── 4. markSubmitted refuses to write after claim was swept ─────
    // A slow write outlives the sweep and another writer reclaims; the late
    // markSubmitted must not clobber the new winner.
    await check("markSubmitted is a no-op after claim is swept + reclaimed", () => {
      const attempt = makeAttempt("swept-then-reclaimed");
      fhenixGatewayTxRepo.insert(dbA, attempt);
      const startedAt = isoMinus(600 * 2); // stale enough to be swept
      const tokenA = randomUUID();
      // Process A claims (with a deliberately stale broadcast_started_at).
      dbA
        .prepare(
          `UPDATE fhenix_gateway_tx_attempts
           SET broadcast_claim_token = ?,
               broadcast_started_at = ?,
               updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(tokenA, startedAt, nowIso(), attempt.attempt_id);

      // Tick sweeps A's stuck claim.
      fhenixGatewayTxRepo.sweepStuckClaims(dbB, {
        stuckBeforeIso: isoMinus(600),
        updated_at: nowIso(),
        errorMessage: "sweep",
      });

      // Process B reclaims successfully.
      const tokenB = randomUUID();
      const ok = fhenixGatewayTxRepo.claimForBroadcast(dbB, {
        attempt_id: attempt.attempt_id,
        broadcast_started_at: nowIso(),
        updated_at: nowIso(),
        token: tokenB,
      });
      assert.equal(ok, true, "B should reclaim after sweep");

      // A's late markSubmitted is rejected by the token guard; B's claim survives.
      const stoleByA = fhenixGatewayTxRepo.markSubmitted(dbA, {
        attempt_id: attempt.attempt_id,
        tx_hash: "0x" + "cc".repeat(32),
        next_attempt_at: nowIso(),
        updated_at: nowIso(),
        broadcast_started_at: startedAt,
        broadcast_latency_ms: 999,
        claim_token: tokenA,
      });
      assert.equal(stoleByA, false, "A's late mark must not write");
      const after = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      // sweep transitioned to failed_retryable; claim doesn't reset status
      assert.equal(after?.status, "failed_retryable");
      assert.equal(after?.broadcast_claim_token, tokenB);
      assert.equal(after?.tx_hash, null);

      // Process B then submits successfully with its own token.
      const okB = fhenixGatewayTxRepo.markSubmitted(dbB, {
        attempt_id: attempt.attempt_id,
        tx_hash: "0x" + "dd".repeat(32),
        next_attempt_at: nowIso(),
        updated_at: nowIso(),
        broadcast_started_at: nowIso(),
        broadcast_latency_ms: 12,
        claim_token: tokenB,
      });
      assert.equal(okB, true, "B's mark with its own token should land");
      const final = fhenixGatewayTxRepo.byId(dbA, attempt.attempt_id);
      assert.equal(final?.status, "submitted");
      assert.equal(final?.broadcast_claim_token, null);
      assert.equal(final?.tx_hash, "0x" + "dd".repeat(32));
    });

    // ── 5. markRetryableFailure refuses to write after sweep+reclaim ─
    // Same as #4 for the catch-path markRetryableFailure.
    await check("markRetryableFailure is a no-op after claim is swept + reclaimed", () => {
      const attempt = makeAttempt("retryable-swept");
      fhenixGatewayTxRepo.insert(dbA, attempt);
      const staleStart = isoMinus(600 * 2);
      const tokenA = randomUUID();
      dbA
        .prepare(
          `UPDATE fhenix_gateway_tx_attempts
           SET broadcast_claim_token = ?,
               broadcast_started_at = ?,
               updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(tokenA, staleStart, nowIso(), attempt.attempt_id);

      fhenixGatewayTxRepo.sweepStuckClaims(dbB, {
        stuckBeforeIso: isoMinus(600),
        updated_at: nowIso(),
        errorMessage: "sweep",
      });

      const tokenB = randomUUID();
      assert.equal(
        fhenixGatewayTxRepo.claimForBroadcast(dbB, {
          attempt_id: attempt.attempt_id,
          broadcast_started_at: nowIso(),
          updated_at: nowIso(),
          token: tokenB,
        }),
        true,
      );

      // A's writeContract eventually threw; A tries markRetryableFailure
      // with its stale token. The token check rejects.
      const stoleByA = fhenixGatewayTxRepo.markRetryableFailure(dbA, {
        attempt_id: attempt.attempt_id,
        last_error: "A's stale retry error",
        next_attempt_at: nowIso(),
        updated_at: nowIso(),
        broadcast_started_at: staleStart,
        broadcast_latency_ms: null,
        claim_token: tokenA,
      });
      assert.equal(stoleByA, false, "A's late retry-mark must not write");
      const after = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      assert.equal(after?.broadcast_claim_token, tokenB);
      assert.notEqual(after?.last_error, "A's stale retry error");
    });

    // ── 6. sweepStuckClaims leaves fresh claims alone ───────────────
    await check("sweepStuckClaims ignores claims newer than stuck threshold", () => {
      const attempt = makeAttempt("fresh");
      fhenixGatewayTxRepo.insert(dbA, attempt);
      const freshStart = nowIso();
      assert.equal(
        fhenixGatewayTxRepo.claimForBroadcast(dbA, {
          attempt_id: attempt.attempt_id,
          broadcast_started_at: freshStart,
          updated_at: freshStart,
          token: randomUUID(),
        }),
        true,
      );
      const released = fhenixGatewayTxRepo.sweepStuckClaims(dbB, {
        stuckBeforeIso: isoMinus(600),
        updated_at: nowIso(),
        errorMessage: "should not fire",
      });
      assert.equal(released, 0);
      const after = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      assert.notEqual(after?.broadcast_claim_token, null);
      assert.equal(after?.status, "queued");
    });

    // ── 7. Reconciliation recovers tx_hash after writeContract timeout ──
    // A prior timed-out write landed: getCall + getLogs recover its tx_hash,
    // with no writeContract and no attempt_count increment.
    await check("reconciliation recovers tx_hash after writeContract timeout", async () => {
      const attempt = makeAttempt("recon");
      // Deterministic agent/market/nonce so the callId can be computed off-chain.
      attempt.client_nonce = "0x" + "9c".repeat(32);
      attempt.market_id_hash = "0x" + "ad".repeat(32);
      attempt.agent_wallet_address = "0x" + "5a".repeat(20);
      fhenixGatewayTxRepo.insert(dbA, attempt);

      const chainId = 84532;
      const contractAddress = "0x" + "11".repeat(20);
      const recoveredCallId = computeSealedCallId(chainId, contractAddress, {
        agentWalletAddress: attempt.agent_wallet_address,
        marketIdHash: attempt.market_id_hash,
        clientNonce: attempt.client_nonce,
      });
      const landedTxHash = ("0x" + "ee".repeat(32)) as Hex;
      const landedBlock = 4242n;
      const landedLogIndex = 7;

      // What markRetryableFailure leaves after a timeout: attempt_count=1, tx_hash=null.
      dbA
        .prepare(
          `UPDATE fhenix_gateway_tx_attempts
           SET status = 'failed_retryable',
               attempt_count = 1,
               last_error = 'submitSealedFor timed out',
               broadcast_started_at = ?,
               updated_at = ?,
               next_attempt_at = ?
           WHERE attempt_id = ?`,
        )
        .run(nowIso(), nowIso(), nowIso(), attempt.attempt_id);

      // Fake client: writeContract must not run; reads return the landed tx.
      let writeContractCalls = 0;
      let readContractCalls = 0;
      let getLogsCalls = 0;
      const sealedCallEventTopic = SEALED_CALL_SUBMITTED_TOPIC;
      const fakeClient: FhenixGatewayClient = {
        getChainId: async () => chainId,
        getBlockNumber: async () => landedBlock + 5n,
        writeContract: async (_args: GatewayWriteContractArgs) => {
          writeContractCalls += 1;
          throw new Error(
            "writeContract must not be called when reconciliation recovered the tx",
          );
        },
        getTransactionReceipt: async () => {
          throw new Error("not used on the broadcast path");
        },
        readContract: async (args: GatewayReadContractArgs) => {
          readContractCalls += 1;
          assert.equal(args.functionName, "getCall");
          assert.equal(args.args[0], recoveredCallId);
          // Any truthy tuple; reconciler only branches on revert vs success.
          return [
            attempt.agent_wallet_address,
            attempt.market_id_hash,
            0n,
            0n,
            0n,
            0,
            0,
            0,
          ];
        },
        getLogs: async (
          args: GatewayGetLogsArgs,
        ): Promise<readonly GatewayLog[]> => {
          getLogsCalls += 1;
          assert.equal(args.args.callId, recoveredCallId);
          return [
            {
              address: contractAddress as Address,
              topics: [
                sealedCallEventTopic as Hex,
                recoveredCallId,
                padHex(attempt.agent_wallet_address as Hex, { size: 32 }),
                attempt.market_id_hash as Hex,
              ],
              data: encodeAbiParameters(
                parseAbiParameters("uint64,uint64,bytes32,bytes32,bytes32,uint8"),
                [
                  BigInt(Math.floor(Date.now() / 1000)),
                  BigInt(Math.floor(Date.now() / 1000) + 3600),
                  ("0x" + "01".repeat(32)) as Hex,
                  ("0x" + "02".repeat(32)) as Hex,
                  attempt.client_nonce as Hex,
                  1, // SubmissionClass.EarlyAccess
                ],
              ),
              logIndex: landedLogIndex,
              blockNumber: landedBlock,
              transactionHash: landedTxHash,
            },
          ];
        },
      };

      await broadcastGatewayAttempt(sealedCallAttemptKind(), {
        db: dbA,
        client: fakeClient,
        chainId,
        contractAddress,
        reconcileFromBlock: 0,
        maxAttempts: 5,
        retryBaseMs: 5_000,
        retryMaxMs: 120_000,
        broadcastTimeoutMs: 0,
        now: () => new Date(),
        attemptId: attempt.attempt_id,
      });

      assert.equal(writeContractCalls, 0, "must not re-broadcast");
      assert.equal(readContractCalls, 1, "reconciler must call readContract once");
      assert.equal(getLogsCalls, 1, "reconciler must call getLogs once");
      const after = fhenixGatewayTxRepo.byId(dbB, attempt.attempt_id);
      assert.equal(after?.status, "submitted");
      assert.equal(after?.tx_hash, landedTxHash.toLowerCase());
      assert.equal(
        after?.attempt_count,
        1,
        "attempt_count must NOT increment on reconciliation",
      );
      assert.equal(after?.broadcast_claim_token, null);
      assert.equal(after?.last_error, null);
    });

    // ── 7b. Kill switch engaged while the write waits in the broadcast queue ──
    // preBroadcast must halt a late engagement terminally; the signer never runs.
    await check("kill switch engaged while queued halts the broadcast (no tx)", async () => {
      const attempt = makeAttempt("queued-halt");
      // Valid input so the halt comes from preBroadcast, not contractWrite().
      // Both halves share one proof (0.7 batch signature).
      const batchProof = "0x" + "bb".repeat(65);
      attempt.binary_index_input_json = JSON.stringify({
        ct_hash: "0x" + "aa".repeat(32),
        security_zone: 0,
        utype: 2,
        signature: batchProof,
      });
      attempt.confidence_input_json = JSON.stringify({
        ct_hash: "0x" + "cc".repeat(32),
        security_zone: 0,
        utype: 3,
        signature: batchProof,
      });
      fhenixGatewayTxRepo.insert(dbA, attempt);
      let signerCalls = 0;
      const haltClient: FhenixGatewayClient = {
        getChainId: async () => 84532,
        getBlockNumber: async () => 1n,
        // Engage first to simulate the switch landing while this write sat in queue.
        writeContract: async (_args, opts) => {
          engageAccountKillSwitch(dbA, {
            account_id: accountId,
            actor: "race-smoke",
            now: () => new Date(),
          });
          opts?.preBroadcast?.();
          signerCalls += 1;
          return ("0x" + "ab".repeat(32)) as Hex;
        },
        getTransactionReceipt: async () => {
          throw new Error("not used");
        },
      };
      const result = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
        db: dbA,
        client: haltClient,
        chainId: 84532,
        contractAddress: "0x" + "11".repeat(20),
        reconcileFromBlock: 0,
        maxAttempts: 5,
        retryBaseMs: 5_000,
        retryMaxMs: 120_000,
        broadcastTimeoutMs: 0,
        now: () => new Date(),
        attemptId: attempt.attempt_id,
      });
      assert.equal(result.kind, "terminal_failure");
      assert.equal(signerCalls, 0, "signer must never run after a late engagement");
      const after = fhenixGatewayTxRepo.byId(dbA, attempt.attempt_id);
      assert.equal(after?.status, "failed_terminal");
      assert.match(after?.last_error ?? "", /kill switch/i);
      // release so later checks in this db are unaffected
      releaseAccountKillSwitch(dbA, {
        account_id: accountId,
        actor: "race-smoke",
        now: () => new Date(),
      });
    });

    // ── 8. Feed-lane reconciliation (same invariant, feed_packet kind) ──
    // Pins the feed lane's id wiring (getFeedPacket + packetId topic filter).
    await check("feed reconciliation recovers tx_hash after writeContract timeout", async () => {
      const feedId = randomUUID();
      dbA.prepare(
        `INSERT INTO feed_contracts (feed_id, agent_id, name, description, status, venue,
           resolution_classes_json, edge_classes_json, covered_market_ids_json,
           delivery_cadence_seconds, trigger_rules_json, max_latency_seconds,
           subscriber_capacity, commercial_template, reveal_policy_json,
           refund_rule_json, slash_rule_json, created_at, updated_at)
         VALUES (?, ?, 'Race Feed', NULL, 'listed', 'polymarket', '[]', '[]', '[]',
           NULL, '{}', NULL, 10, 'per_alert', '{"kind":"after_resolution"}',
           '{}', '{}', ?, ?)`,
      ).run(feedId, agentId, ts, ts);

      const attempt: FhenixGatewayFeedPacketTxAttemptInsert = {
        attempt_id: randomUUID(),
        status: "queued",
        request_fingerprint: null,
        auth_proof: null,
        runtime_key_id: null,
        runtime_key_policy_hash: "0x" + "00".repeat(32),
        runtime_key_policy_json: "{}",
        account_id: accountId,
        agent_id: agentId,
        chain_id: 84532,
        contract_address: "0x" + "11".repeat(20),
        relayer_address: "0x" + "22".repeat(20),
        agent_wallet_address: "0x" + "6b".repeat(20),
        feed_id: feedId,
        feed_id_hash: "0x" + "fe".repeat(32),
        market_id: null,
        market_id_hash: "0x" + "ad".repeat(32),
        packet_kind: "verdict",
        sequence: 1,
        payload_schema: "verdict-v1",
        client_order_id: "race-feed-order-recon",
        client_nonce: "0x" + "7d".repeat(32),
        submitted_at: ts,
        delivery_deadline_at: null,
        reveal_after: new Date(Date.now() + 3600_000).toISOString(),
        action_input_json: "{}",
        signal_input_json: "{}",
        action_ct_hash: null,
        signal_ct_hash: null,
        next_attempt_at: ts,
        created_at: ts,
        updated_at: ts,
      };
      fhenixGatewayFeedPacketTxRepo.insert(dbA, attempt);

      const chainId = 84532;
      const contractAddress = "0x" + "11".repeat(20);
      const recoveredPacketId = computeFeedPacketId(chainId, contractAddress, {
        agentWalletAddress: attempt.agent_wallet_address,
        feedIdHash: attempt.feed_id_hash,
        marketIdHash: attempt.market_id_hash,
        clientNonce: attempt.client_nonce,
      });
      const landedTxHash = ("0x" + "cd".repeat(32)) as Hex;
      const landedBlock = 5151n;
      const landedLogIndex = 3;

      // Same shape as the sealed case: a prior failed broadcast left
      // attempt_count=1, tx_hash=null, status='failed_retryable'.
      dbA
        .prepare(
          `UPDATE fhenix_gateway_feed_packet_tx_attempts
           SET status = 'failed_retryable',
               attempt_count = 1,
               last_error = 'submitFeedPacketFor timed out',
               broadcast_started_at = ?,
               updated_at = ?,
               next_attempt_at = ?
           WHERE attempt_id = ?`,
        )
        .run(nowIso(), nowIso(), nowIso(), attempt.attempt_id);

      let writeContractCalls = 0;
      let readContractCalls = 0;
      let getLogsCalls = 0;
      const feedPacketEventTopic = FEED_PACKET_SUBMITTED_TOPIC;
      const fakeClient: FhenixGatewayClient = {
        getChainId: async () => chainId,
        getBlockNumber: async () => landedBlock + 5n,
        writeContract: async (_args: GatewayWriteContractArgs) => {
          writeContractCalls += 1;
          throw new Error(
            "writeContract must not be called when feed reconciliation recovered the tx",
          );
        },
        getTransactionReceipt: async () => {
          throw new Error("not used on the broadcast path");
        },
        readContract: async (args: GatewayReadContractArgs) => {
          readContractCalls += 1;
          assert.equal(args.functionName, "getFeedPacket");
          assert.equal(args.args[0], recoveredPacketId);
          // Any truthy tuple; reconciler only branches on revert vs success.
          return [
            attempt.agent_wallet_address,
            attempt.feed_id_hash,
            attempt.market_id_hash,
            0n,
            0n,
            "0x" + "01".repeat(32),
            "0x" + "02".repeat(32),
            0,
            0,
            0,
          ];
        },
        getLogs: async (
          args: GatewayGetLogsArgs,
        ): Promise<readonly GatewayLog[]> => {
          getLogsCalls += 1;
          assert.equal(args.args.packetId, recoveredPacketId);
          // findSubmitEvent only reads transactionHash/logIndex/blockNumber;
          // the topic layout mirrors the real indexed fields for realism.
          return [
            {
              address: contractAddress as Address,
              topics: [
                feedPacketEventTopic as Hex,
                recoveredPacketId,
                padHex(attempt.agent_wallet_address as Hex, { size: 32 }),
                attempt.feed_id_hash as Hex,
              ],
              data: "0x" as Hex,
              logIndex: landedLogIndex,
              blockNumber: landedBlock,
              transactionHash: landedTxHash,
            },
          ];
        },
      };

      await broadcastGatewayAttempt(feedPacketAttemptKind(), {
        db: dbA,
        client: fakeClient,
        chainId,
        contractAddress,
        reconcileFromBlock: 0,
        maxAttempts: 5,
        retryBaseMs: 5_000,
        retryMaxMs: 120_000,
        broadcastTimeoutMs: 0,
        now: () => new Date(),
        attemptId: attempt.attempt_id,
      });

      assert.equal(writeContractCalls, 0, "must not re-broadcast feed packet");
      assert.equal(readContractCalls, 1, "feed reconciler must call readContract once");
      assert.equal(getLogsCalls, 1, "feed reconciler must call getLogs once");
      const after = fhenixGatewayFeedPacketTxRepo.byId(dbB, attempt.attempt_id);
      assert.equal(after?.status, "submitted");
      assert.equal(after?.tx_hash, landedTxHash.toLowerCase());
      assert.equal(
        after?.attempt_count,
        1,
        "attempt_count must NOT increment on feed reconciliation",
      );
      assert.equal(after?.broadcast_claim_token, null);
      assert.equal(after?.last_error, null);
    });

    console.log("fhenix gateway race smoke ok");
  } finally {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
