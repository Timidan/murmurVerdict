import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../verdict/db.js";
import { fhenixGatewayTxRepo } from "../verdict/repos/fhenix-gateway-tx-repo.js";
import type { FhenixGatewayTxAttemptInsert } from "../verdict/repos/fhenix-gateway-tx-repo.js";
import { broadcastGatewayAttempt } from "./fhenix-gateway-attempt-machine.js";
import { FhenixGatewayBroadcaster } from "./fhenix-gateway.js";
import { sealedCallAttemptKind } from "./fhenix-gateway-attempt-kinds.js";
import type { FhenixGatewayClient } from "./fhenix-gateway-contract.js";

// Two fences that only matter across a REDEPLOY, so nothing else exercises
// them: an attempt reserved against one deployment must never be relayed onto
// another, and terminalizing it must not leave the row looking in-flight.
process.stdout.write("murmur fhenix gateway fences smoke\n");

const OLD_CONTRACT = `0x${"aa".repeat(20)}`;
const NEW_CONTRACT = `0x${"bb".repeat(20)}`;
const RELAYER = `0x${"22".repeat(20)}`;
const AGENT_WALLET = `0x${"6b".repeat(20)}`;

function seedAttempt(
  db: ReturnType<typeof openDb>,
  overrides: Partial<FhenixGatewayTxAttemptInsert> = {},
): string {
  const accountId = randomUUID();
  const agentId = randomUUID();
  const ts = "2026-07-26T01:00:00.000Z";
  db.prepare(
    `INSERT INTO accounts (account_id, privy_user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, `did:privy:fence-${agentId.slice(0, 8)}`, ts, ts);
  db.prepare(
    `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio,
       created_at, api_key_hash, wallet_address, chain_id)
     VALUES (?, ?, 'agent', 'Fence Agent', NULL, ?, NULL, NULL, NULL)`,
  ).run(agentId, `fence-${agentId.slice(0, 8)}`, ts);
  db.prepare(
    `INSERT INTO account_agents (account_id, agent_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(accountId, agentId, ts);

  const attemptId = randomUUID();
  fhenixGatewayTxRepo.insert(db, {
    attempt_id: attemptId,
    status: "queued",
    request_fingerprint: null,
    auth_proof: null,
    runtime_key_id: null,
    runtime_key_policy_hash: `0x${"00".repeat(32)}`,
    runtime_key_policy_json: "{}",
    account_id: accountId,
    agent_id: agentId,
    chain_id: 84532,
    contract_address: OLD_CONTRACT,
    relayer_address: RELAYER,
    agent_wallet_address: AGENT_WALLET,
    market_id: "eth.1h",
    market_id_hash: `0x${"ad".repeat(32)}`,
    market_ref_protocol: "polymarket-gamma",
    market_config_version: 1,
    client_order_id: `fence-${attemptId.slice(0, 8)}`,
    // Unique per attempt: the table has UNIQUE on
    // (chain, contract, agent, market, client_nonce).
    client_nonce: `0x${attemptId.replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`,
    submitted_at: ts,
    rationale: null,
    strategy_tag: "momentum",
    binary_index_input_json: JSON.stringify({
      ct_hash: `0x${"01".repeat(32)}`,
      security_zone: 0,
      utype: 2,
      signature: "0x00",
    }),
    confidence_input_json: JSON.stringify({
      ct_hash: `0x${"02".repeat(32)}`,
      security_zone: 0,
      utype: 3,
      signature: "0x00",
    }),
    next_attempt_at: ts,
    created_at: ts,
    updated_at: ts,
    ...overrides,
  } as FhenixGatewayTxAttemptInsert);
  return attemptId;
}

/** Never reached in these cases — that is the assertion. */
const refusingClient = {
  getChainId: async () => 84532,
  getBlockNumber: async () => 1n,
  writeContract: async () => {
    throw new Error("writeContract must not run across a deployment change");
  },
  getTransactionReceipt: async () => {
    throw new Error("unused");
  },
  readContract: async () => null,
  getLogs: async () => [],
} as unknown as FhenixGatewayClient;

const tmp = mkdtempSync(join(tmpdir(), "gateway-fences-"));
try {
  // ── A redeploy must not relay an intent formed against the old contract ───
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    const result = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client: refusingClient,
      chainId: 84532,
      // The daemon now runs a DIFFERENT contract.
      contractAddress: NEW_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      attemptId,
    } as never);
    assert.equal(result.kind, "terminal_failure");
    const row = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(row?.status, "failed_terminal");
    assert.match(row?.last_error ?? "", /deployment changed/);
    assert.match(row?.last_error ?? "", new RegExp(OLD_CONTRACT, "i"));
    // The claim is released: a terminal row that still looks claimed makes
    // stuck-claim telemetry report finished work forever.
    assert.equal(row?.broadcast_claim_token ?? null, null);
    assert.equal(row?.broadcast_started_at ?? null, null);
    db.close();
  }

  // ── A CHAIN change is caught too, even at an identical address ────────────
  // Comparing the address alone missed this: the same address can exist on
  // another chain, and repointing the daemon there would relay an old-chain
  // intent onto it.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    const result = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client: refusingClient,
      // Same contract address, different chain.
      chainId: 11155111,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      attemptId,
    } as never);
    assert.equal(result.kind, "terminal_failure", "a chain switch is a mismatch too");
    assert.match(
      fhenixGatewayTxRepo.byId(db, attemptId)?.last_error ?? "",
      /chain 84532/,
      "the error names the chain the intent was formed against",
    );
    db.close();
  }

  // ── The SAME deployment still broadcasts normally ─────────────────────────
  // Guards that fire on everything are not guards.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    let wrote = 0;
    const writingClient = {
      ...refusingClient,
      writeContract: async () => {
        wrote += 1;
        return `0x${"99".repeat(32)}`;
      },
      getTransactionReceipt: async () => ({ status: "success", logs: [] }),
    } as unknown as FhenixGatewayClient;
    await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client: writingClient,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      attemptId,
    } as never);
    assert.equal(wrote, 1, "an unchanged deployment broadcasts as before");
    db.close();
  }
  // ── The RPC's ACTUAL chain is checked, not just the configured one ────────
  // Every other deployment guard compares config to config, so a
  // FHENIX_CHAIN_ID that disagrees with the RPC behind FHENIX_RPC_URL passed
  // all of them and broadcast onto the wrong chain.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const gateway = new FhenixGatewayBroadcaster({
      db,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      relayerAddress: RELAYER,
      client: {
        ...refusingClient,
        // The RPC is on a DIFFERENT chain than the config claims.
        getChainId: async () => 11155111,
      } as unknown as FhenixGatewayClient,
      confirmations: 2,
      feedRevealAcknowledged: false,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
    } as never);
    await assert.rejects(
      () => gateway.tick(),
      (err: unknown) =>
        err instanceof Error &&
        /serves chain 11155111 but FHENIX_CHAIN_ID is 84532/.test(err.message),
      "a tick refuses to run when the RPC is not the configured chain",
    );
    db.close();
  }

  // ── A terminal decision must not steal an in-flight worker's claim ────────
  // markTerminalFailure used to clear broadcast_claim_token unconditionally.
  // A worker mid-writeContract then found its token-guarded markSubmitted
  // matched zero rows, and a transaction that actually landed was recorded
  // nowhere.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    const claimed = fhenixGatewayTxRepo.claimForBroadcast(db, {
      attempt_id: attemptId,
      token: "worker-a",
      broadcast_started_at: "2026-07-26T02:00:00.000Z",
      updated_at: "2026-07-26T02:00:00.000Z",
    });
    assert.equal(claimed, true, "worker A holds the claim");

    // Worker B terminalizes WITHOUT a token (a pre-claim decision). It must
    // report FALSE and change nothing: the row belongs to A, or to the
    // stuck-claim sweep. Leaving the claim attached while flipping the status
    // to terminal was the earlier bug — the sweep only scans broadcastable
    // rows, so the claim would never be released and, if A's transaction had
    // landed, its hash would never be recovered.
    assert.equal(
      fhenixGatewayTxRepo.markTerminalFailure(db, {
        attempt_id: attemptId,
        last_error: "kill switch engaged before broadcast",
        updated_at: "2026-07-26T02:00:01.000Z",
      }),
      false,
      "a tokenless terminal decision cannot touch a claimed row",
    );
    const stillClaimed = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(stillClaimed?.broadcast_claim_token, "worker-a");
    assert.notEqual(
      stillClaimed?.status,
      "failed_terminal",
      "...and does not flip its status either",
    );

    // A holder of a STALE token changes nothing.
    assert.equal(
      fhenixGatewayTxRepo.markTerminalFailure(db, {
        attempt_id: attemptId,
        last_error: "stale",
        updated_at: "2026-07-26T02:00:02.000Z",
        expect_claim_token: "worker-b",
      }),
      false,
      "a stale token is a no-op, not a clobber",
    );
    assert.equal(
      fhenixGatewayTxRepo.byId(db, attemptId)?.broadcast_claim_token,
      "worker-a",
    );

    // The OWNER releases it.
    assert.equal(
      fhenixGatewayTxRepo.markTerminalFailure(db, {
        attempt_id: attemptId,
        last_error: "halted in slot",
        updated_at: "2026-07-26T02:00:03.000Z",
        expect_claim_token: "worker-a",
      }),
      true,
    );
    assert.equal(
      fhenixGatewayTxRepo.byId(db, attemptId)?.broadcast_claim_token ?? null,
      null,
      "the claim owner releases its own claim",
    );
    db.close();
  }
  // ── A late transaction is journalled without stealing the new claim ───────
  // Worker A's write lands after its claim was swept and re-taken by B. A's
  // guarded markSubmitted matches nothing; the hash must still be recorded,
  // and B's claim must survive. The obvious fallback (markReconciledSubmitted)
  // has no claim guard and would have wiped it.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    fhenixGatewayTxRepo.claimForBroadcast(db, {
      attempt_id: attemptId,
      token: "worker-b",
      broadcast_started_at: "2026-07-26T02:00:00.000Z",
      updated_at: "2026-07-26T02:00:00.000Z",
    });

    // A's guarded write loses — its token is stale.
    assert.equal(
      fhenixGatewayTxRepo.markSubmitted(db, {
        attempt_id: attemptId,
        tx_hash: `0x${"5a".repeat(32)}`,
        next_attempt_at: "2026-07-26T02:05:00.000Z",
        updated_at: "2026-07-26T02:00:01.000Z",
        broadcast_started_at: "2026-07-26T01:59:00.000Z",
        broadcast_latency_ms: 60_000,
        claim_token: "worker-a",
      }),
      false,
      "a stale claim token cannot record a submission",
    );

    // ...so the hash is journalled instead.
    assert.equal(
      fhenixGatewayTxRepo.journalLateTxHash(db, {
        attempt_id: attemptId,
        tx_hash: `0x${"5a".repeat(32)}`,
        updated_at: "2026-07-26T02:00:01.000Z",
      }),
      true,
    );
    const row = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(row?.tx_hash, `0x${"5a".repeat(32)}`, "the real write is not lost");
    assert.equal(
      row?.broadcast_claim_token,
      "worker-b",
      "the new owner's claim survives",
    );

    // A second journal does not overwrite a hash someone else recorded.
    assert.equal(
      fhenixGatewayTxRepo.journalLateTxHash(db, {
        attempt_id: attemptId,
        tx_hash: `0x${"99".repeat(32)}`,
        updated_at: "2026-07-26T02:00:02.000Z",
      }),
      false,
    );
    assert.equal(fhenixGatewayTxRepo.byId(db, attemptId)?.tx_hash, `0x${"5a".repeat(32)}`);
    db.close();
  }
  // ── A late hash reaches CONFIRMATION, not terminal failure ────────────────
  // The duplicate-broadcast guard threw GatewayBroadcastHaltedError, which the
  // catch treats as terminal. Confirmation only scans `submitted` rows, so the
  // transaction that actually landed was recorded and then never looked at
  // again. It must be handed to the confirmation loop instead.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    const landedHash = `0x${"5a".repeat(32)}`;
    let wrote = 0;
    const client = {
      ...refusingClient,
      writeContract: async (_args: unknown, opts?: { preBroadcast?: () => void }) => {
        // An earlier worker's write lands and journals its hash while this
        // attempt sits in the queue — exactly the window preBroadcast covers.
        fhenixGatewayTxRepo.journalLateTxHash(db, {
          attempt_id: attemptId,
          tx_hash: landedHash,
          updated_at: "2026-07-26T02:00:00.500Z",
        });
        opts?.preBroadcast?.();
        wrote += 1;
        return `0x${"99".repeat(32)}`;
      },
    } as unknown as FhenixGatewayClient;

    const result = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:01.000Z"),
      attemptId,
    } as never);

    assert.equal(wrote, 0, "no duplicate transaction is sent");
    assert.equal(result.kind, "reconciled");
    const row = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(
      row?.status,
      "submitted",
      "the row reaches confirmation — `failed_terminal` would strand the landed write",
    );
    assert.equal(row?.tx_hash, landedHash, "and carries the hash that actually landed");
    db.close();
  }
  // ── The hash write is FIRST-WINS across the non-atomic handoff ────────────
  // preBroadcast and journalLateTxHash are two operations, so worker B can
  // pass the check just BEFORE A's recovered hash appears. B then sends a
  // duplicate — unavoidable once two workers hold the row — but its hash must
  // not replace the one that landed, because the duplicate reverts and
  // confirmation would then terminalize the row and strand the real write.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    const landedHash = `0x${"aa".repeat(32)}`;
    const duplicateHash = `0x${"bb".repeat(32)}`;
    const client = {
      ...refusingClient,
      writeContract: async (_args: unknown, opts?: { preBroadcast?: () => void }) => {
        // B passes the check while tx_hash is still NULL...
        opts?.preBroadcast?.();
        // ...and only THEN does A's recovered hash get journalled.
        fhenixGatewayTxRepo.journalLateTxHash(db, {
          attempt_id: attemptId,
          tx_hash: landedHash,
          updated_at: "2026-07-26T02:00:00.500Z",
        });
        return duplicateHash;
      },
    } as unknown as FhenixGatewayClient;

    await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:01.000Z"),
      attemptId,
    } as never);

    const raced = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(
      raced?.tx_hash,
      landedHash,
      "the first-recorded hash stands; the duplicate does not replace it",
    );
    // ...and the row must still REACH confirmation. Leaving it `queued` with
    // the claim held meant confirmation (which scans `submitted`) never saw
    // it, and once the claim was swept it rebroadcast duplicates forever.
    assert.equal(raced?.status, "submitted", "the row is handed to confirmation");
    assert.equal(
      raced?.broadcast_claim_token ?? null,
      null,
      "and its claim is released",
    );
    db.close();
  }
  // ── A row that already carries a hash is PROMOTED, never re-broadcast ─────
  // The general case, and the one that bites in normal operation: viem's
  // writeContract gas-estimates first, so a duplicate reverts with
  // CallAlreadyExists BEFORE returning any hash. The generic catch then marked
  // the row retryable, and every later tick did the same — the landed
  // transaction was never confirmed.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const landedHash = `0x${"7c".repeat(32)}`;
    const attemptId = seedAttempt(db);
    fhenixGatewayTxRepo.journalLateTxHash(db, {
      attempt_id: attemptId,
      tx_hash: landedHash,
      updated_at: "2026-07-26T01:30:00.000Z",
    });

    const result = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      // Any write attempt at all is the bug.
      client: refusingClient,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      attemptId,
    } as never);

    assert.equal(result.kind, "reconciled");
    const row = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(row?.status, "submitted", "promoted straight to confirmation");
    assert.equal(row?.tx_hash, landedHash, "keeping the hash that landed");
    assert.equal(row?.broadcast_claim_token ?? null, null);

    // ...and it outranks the authorization checks. A kill switch engaged after
    // the write landed does not un-send it; terminalizing here would drop the
    // row out of confirmation and strand a real transaction.
    const killedId = seedAttempt(db);
    fhenixGatewayTxRepo.journalLateTxHash(db, {
      attempt_id: killedId,
      tx_hash: `0x${"3d".repeat(32)}`,
      updated_at: "2026-07-26T01:30:00.000Z",
    });
    const killedRow = fhenixGatewayTxRepo.byId(db, killedId);
    db.prepare(
      `UPDATE accounts SET agent_credentials_disabled_at = ? WHERE account_id = ?`,
    ).run("2026-07-26T01:45:00.000Z", killedRow?.account_id);

    const killedResult = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client: refusingClient,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      attemptId: killedId,
    } as never);
    assert.equal(killedResult.kind, "reconciled");
    assert.equal(
      fhenixGatewayTxRepo.byId(db, killedId)?.status,
      "submitted",
      "a kill switch does not strand a transaction that already landed",
    );
    db.close();
  }
  // ── ...and the same ordering holds INSIDE the broadcast slot ─────────────
  // The hash arrives while the attempt waits in the serialized queue, and the
  // account is kill-switched in the same window. The slot's auth checks used
  // to run first, so the row went terminal while holding a hash for a
  // transaction that had already landed.
  {
    const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
    const attemptId = seedAttempt(db);
    const landedHash = `0x${"4e".repeat(32)}`;
    const seeded = fhenixGatewayTxRepo.byId(db, attemptId);
    const client = {
      ...refusingClient,
      writeContract: async (_args: unknown, opts?: { preBroadcast?: () => void }) => {
        // Both happen during the queue wait.
        fhenixGatewayTxRepo.journalLateTxHash(db, {
          attempt_id: attemptId,
          tx_hash: landedHash,
          updated_at: "2026-07-26T01:59:00.000Z",
        });
        db.prepare(
          `UPDATE accounts SET agent_credentials_disabled_at = ? WHERE account_id = ?`,
        ).run("2026-07-26T01:59:30.000Z", seeded?.account_id);
        opts?.preBroadcast?.();
        throw new Error("writeContract must not proceed past preBroadcast here");
      },
    } as unknown as FhenixGatewayClient;

    const result = await broadcastGatewayAttempt(sealedCallAttemptKind(), {
      db,
      client,
      chainId: 84532,
      contractAddress: OLD_CONTRACT,
      reconcileFromBlock: 0,
      maxAttempts: 5,
      retryBaseMs: 5_000,
      retryMaxMs: 120_000,
      broadcastTimeoutMs: 1_000,
      now: () => new Date("2026-07-26T02:00:00.000Z"),
      attemptId,
    } as never);

    assert.equal(result.kind, "reconciled");
    const row = fhenixGatewayTxRepo.byId(db, attemptId);
    assert.equal(
      row?.status,
      "submitted",
      "a kill switch arriving in the queue window does not strand a landed write",
    );
    assert.equal(row?.tx_hash, landedHash);
    db.close();
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.stdout.write("OK fhenix gateway fences smoke\n");
