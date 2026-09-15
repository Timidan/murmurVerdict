import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentsRepo,
  fhenixSealedCallsRepo,
  openDb,
  submissionsRepo,
} from "../verdict/db.js";
import { fhenixRevealJobsRepo } from "../verdict/repos/fhenix-reveal-jobs-repo.js";
import {
  CALL_STATE,
  FhenixRevealWorker,
  RevealWrongStateError,
  type RevealChainAdapter,
  type RevealChainCall,
  type RevealChainReceipt,
  type RevealDecryptor,
} from "./fhenix-reveal-worker.js";

process.stdout.write("murmur fhenix reveal worker smoke\n");

const CHAIN_ID = 84532;
const CONTRACT = "0x2222222222222222222222222222222222222222";
const BIN_CT = "0x" + "aa".repeat(32);
const CONF_CT = "0x" + "bb".repeat(32);

// A scriptable chain the worker drives. `state` is the authoritative on-chain
// CallState; the smoke mutates it between ticks to walk the state machine.
class FakeChain implements RevealChainAdapter {
  state: number = CALL_STATE.Sealed;
  headBlock = 100;
  headTimestampSec: number;
  binCt = BIN_CT;
  confCt = CONF_CT;
  callExists = true;
  opened: string[] = [];
  published: Array<{ binaryIndex: number; confidenceBps: number }> = [];
  receipts = new Map<string, RevealChainReceipt>();
  openThrowsWrongState = false;
  publishThrowsWrongState = false;
  // When true, broadcast txs are NOT given a receipt — models a dropped /
  // nonce-gapped tx that never mines (getReceipt returns null forever).
  dropBroadcasts = false;

  constructor(headTimestampSec: number) {
    this.headTimestampSec = headTimestampSec;
  }

  async safeHead() {
    return { blockNumber: this.headBlock, timestamp: this.headTimestampSec };
  }

  async getCall(): Promise<RevealChainCall | null> {
    if (!this.callExists) return null;
    return { state: this.state, binaryIndexCtHash: this.binCt, confidenceCtHash: this.confCt };
  }

  async sendOpenReveal(id: string): Promise<string> {
    if (this.openThrowsWrongState) throw new RevealWrongStateError();
    const tx = `0xopen${this.opened.length}`;
    this.opened.push(id);
    if (!this.dropBroadcasts) {
      this.receipts.set(tx, { blockNumber: this.headBlock, success: true });
    }
    return tx;
  }

  async sendPublishReveal(
    _id: string,
    args: { binaryIndex: number; confidenceBps: number },
  ): Promise<string> {
    if (this.publishThrowsWrongState) throw new RevealWrongStateError();
    const tx = `0xpub${this.published.length}`;
    this.published.push({ binaryIndex: args.binaryIndex, confidenceBps: args.confidenceBps });
    if (!this.dropBroadcasts) {
      this.receipts.set(tx, { blockNumber: this.headBlock, success: true });
    }
    return tx;
  }

  async getReceipt(txHash: string): Promise<RevealChainReceipt | null> {
    return this.receipts.get(txHash) ?? null;
  }
}

class FakeDecryptor implements RevealDecryptor {
  failFor = new Set<string>();
  calls: string[] = [];
  async decrypt(ctHash: string): Promise<{ value: number; signature: string }> {
    this.calls.push(ctHash);
    if (this.failFor.has(ctHash)) throw new Error("threshold 403 not ready");
    return { value: ctHash === BIN_CT ? 1 : 7200, signature: `0xsig-${ctHash.slice(2, 8)}` };
  }
}

let seedSeq = 0;
function seedSealedCall(
  db: ReturnType<typeof openDb>,
  callId: string,
  onchainCallId: string,
  revealOpenAt: string,
): void {
  seedSeq += 1;
  const submitTxHash = "0x" + seedSeq.toString(16).padStart(64, "0");
  submissionsRepo.acceptSealedFhenixCall(db, {
    call_id: callId,
    agent_id: agentId,
    client_order_id: `order-${callId}`,
    horizon_seconds: 3600,
    submitted_at: "2026-05-14T12:00:00Z",
    accepted_at: "2026-05-14T12:00:00Z",
    rationale: null,
    strategy_tag: "momentum",
    schema_version: 1,
    scoring_version: 1,
    dedup_key: `${callId}:dedup`,
    commit_hash: "0x" + "11".repeat(32),
    commit_scheme: "fhenix-sealed-v1",
    market_id: "eth.1h",
    market_config_version: 1,
    adapter_id: "native-price",
    market_family: "financial-direction",
  });
  fhenixSealedCallsRepo.insert(db, {
    call_id: callId,
    chain_id: CHAIN_ID,
    contract_address: CONTRACT,
    onchain_call_id: onchainCallId,
    submit_tx_hash: submitTxHash,
    submit_log_index: 0,
    binary_index_ct_hash: BIN_CT,
    confidence_ct_hash: CONF_CT,
    reveal_open_at: revealOpenAt,
    submission_class: 1,
    created_at: "2026-05-14T12:00:00Z",
  });
  submissionsRepo.setStatus(db, callId, "pending_t1");
}

const tmp = mkdtempSync(join(tmpdir(), "reveal-worker-"));
const agentId = randomUUID();

// Isolated DB per check so listDue() never picks up another test's jobs.
function freshDb(): ReturnType<typeof openDb> {
  const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });
  agentsRepo.insert(db, {
    agent_id: agentId,
    display_slug: "reveal-worker-smoke",
    kind: "agent",
    display_name: "Reveal Worker Smoke",
    created_at: "2026-05-14T12:00:00Z",
    wallet_address: "0x1111111111111111111111111111111111111111",
    chain_id: `eip155:${CHAIN_ID}`,
  });
  return db;
}

// Clock the smoke advances between ticks so backoff'd jobs come due again.
let clockMs = Date.parse("2026-05-14T14:00:00Z");
const now = () => new Date(clockMs);
const headTs = Math.floor(clockMs / 1000);

function makeWorker(
  db: ReturnType<typeof openDb>,
  chain: FakeChain,
  decryptor: FakeDecryptor,
): FhenixRevealWorker {
  return new FhenixRevealWorker({
    db,
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    chain,
    decryptor,
    graceSeconds: 300,
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    rebroadcastMs: 30_000,
    maxJobsPerTick: 5,
    maxConcurrency: 2,
    warnMs: 600_000,
    escalateMs: 1_800_000,
    now,
    logger: { log: () => undefined, warn: () => undefined },
    random: () => 0.5,
  });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ok ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  NOT OK ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// reveal_open_at is well before headTs - grace, so it is eligible.
const revealOpenAt = "2026-05-14T13:00:00Z";

await check("grace gating: a call still inside the agent grace window is NOT seeded", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "31".repeat(32), "2026-05-14T13:59:00Z"); // 60s ago < 300s grace
  const chain = new FakeChain(headTs);
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(fhenixRevealJobsRepo.byCallId(db, callId), null);
  db.close();
});

await check("Sealed → broadcasts openReveal, one transition, stops for the tick", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "32".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Sealed;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  const job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "open_tx_pending");
  assert.ok(job?.open_tx_hash);
  assert.equal(chain.opened.length, 1);
  assert.equal(chain.published.length, 0); // did NOT publish in the same tick
  db.close();
});

await check("Opened → decrypts both ciphertexts then publishes", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "33".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Opened;
  const decryptor = new FakeDecryptor();
  await makeWorker(db, chain, decryptor).tick();
  const job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "publish_tx_pending");
  assert.ok(job?.publish_tx_hash);
  assert.equal(job?.binary_index_value, 1);
  assert.equal(job?.confidence_value, 7200);
  assert.equal(chain.published.length, 1);
  assert.deepEqual(chain.published[0], { binaryIndex: 1, confidenceBps: 7200 });
  db.close();
});

await check("partial decrypt persists the settled ciphertext and retries the 403", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "34".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Opened;
  const decryptor = new FakeDecryptor();
  decryptor.failFor.add(CONF_CT); // binary decrypts, confidence 403s
  await makeWorker(db, chain, decryptor).tick();
  let job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "partially_decrypted");
  assert.equal(job?.binary_index_value, 1);
  assert.equal(job?.confidence_value, null);
  assert.equal(chain.published.length, 0);

  // Next pass the 403 clears; only the missing ciphertext is re-requested.
  clockMs += 60_000;
  decryptor.failFor.clear();
  decryptor.calls.length = 0;
  await makeWorker(db, chain, decryptor).tick();
  job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "publish_tx_pending");
  assert.deepEqual(decryptor.calls, [CONF_CT]); // settled binary NOT re-requested
  clockMs -= 60_000;
  db.close();
});

await check("Revealed by our publish tx → terminal_daemon", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "35".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Opened;
  await makeWorker(db, chain, new FakeDecryptor()).tick(); // publishes
  chain.state = CALL_STATE.Revealed; // our tx landed
  clockMs += 60_000;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(fhenixRevealJobsRepo.byCallId(db, callId)?.phase, "terminal_daemon");
  clockMs -= 60_000;
  db.close();
});

await check("Revealed by someone else (no successful publish tx) → terminal_external", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "36".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Revealed; // already revealed before we acted
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  const job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "terminal_external");
  assert.equal(job?.publish_tx_hash, null);
  assert.equal(chain.published.length, 0);
  db.close();
});

await check("WrongState on open is a reconcile signal, not a terminal failure", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "37".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Sealed;
  chain.openThrowsWrongState = true;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  const job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.notEqual(job?.phase, "terminal_external");
  assert.notEqual(job?.phase, "terminal_daemon");
  assert.equal(job?.attempt_count, 0); // reconcile does NOT penalize
  db.close();
});

await check("getCall None at safe head → quarantine + escalate alert", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "38".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.callExists = false;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  const job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "quarantined");
  assert.equal(job?.alert_level, "escalate");
  db.close();
});

await check("on-chain ct handle mismatch → quarantine (never acts)", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "39".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Sealed;
  chain.binCt = "0x" + "cc".repeat(32); // does not match stored BIN_CT
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  const job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "quarantined");
  assert.equal(chain.opened.length, 0);
  db.close();
});

await check("dropped open tx re-broadcasts ONLY after it goes stale (self-heal)", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "3a".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Sealed;
  chain.dropBroadcasts = true; // the open never mines → getReceipt null forever
  const base = clockMs;

  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(chain.opened.length, 1);
  let job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "open_tx_pending");
  assert.ok(job?.tx_broadcast_at);

  // Still within rebroadcastMs (10s < 30s) → reconcile, never re-broadcast.
  clockMs = base + 10_000;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(chain.opened.length, 1, "must NOT re-broadcast before staleness");

  // Past rebroadcastMs (40s > 30s) → self-heal by re-broadcasting the open.
  clockMs = base + 40_000;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(chain.opened.length, 2, "stale receiptless open must re-broadcast");
  job = fhenixRevealJobsRepo.byCallId(db, callId);
  assert.equal(job?.phase, "open_tx_pending");

  clockMs = base;
  db.close();
});

await check("dropped publish tx re-broadcasts after staleness without re-decrypting", async () => {
  const db = freshDb();
  const callId = randomUUID();
  seedSealedCall(db, callId, "0x" + "3b".repeat(32), revealOpenAt);
  const chain = new FakeChain(headTs);
  chain.state = CALL_STATE.Opened;
  chain.dropBroadcasts = true; // the publish never mines
  const base = clockMs;

  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(chain.published.length, 1);
  assert.equal(fhenixRevealJobsRepo.byCallId(db, callId)?.phase, "publish_tx_pending");

  // Within staleness → reconcile, no re-publish.
  clockMs = base + 10_000;
  await makeWorker(db, chain, new FakeDecryptor()).tick();
  assert.equal(chain.published.length, 1, "must NOT re-broadcast before staleness");

  // Past staleness → re-publish from persisted values, no new decrypt calls.
  clockMs = base + 40_000;
  const decryptor = new FakeDecryptor();
  await makeWorker(db, chain, decryptor).tick();
  assert.equal(chain.published.length, 2, "stale receiptless publish must re-broadcast");
  assert.equal(decryptor.calls.length, 0, "persisted decrypt values are not re-requested");

  clockMs = base;
  db.close();
});

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  process.stderr.write(`fhenix reveal worker smoke FAILED (${failures})\n`);
  process.exit(1);
}
process.stdout.write("fhenix reveal worker smoke ok\n");
