import type Database from "better-sqlite3";

import { fhenixSealedCallsRepo } from "../verdict/repos/fhenix-sealed-calls-repo.js";
import {
  fhenixRevealJobsRepo,
  type FhenixRevealJobPhase,
  type FhenixRevealJobRow,
} from "../verdict/repos/fhenix-reveal-jobs-repo.js";
import { isoFromMs, nowIso } from "../verdict/time.js";

// On-chain CallState (contracts/src/MurmurSealedVerdicts.sol:29).
export const CALL_STATE = {
  None: 0,
  Sealed: 1,
  Opened: 2,
  Revealed: 3,
  Invalid: 4,
} as const;

export interface RevealChainCall {
  state: number;
  binaryIndexCtHash: string;
  confidenceCtHash: string;
}

export interface RevealChainReceipt {
  blockNumber: number;
  success: boolean;
}

// The chain seam the worker drives. The env builder supplies the viem-backed
// implementation; smokes supply a fake so the state machine is exercised
// without a network. openReveal / publishReveal broadcast through the reveal
// EOA's own serial queue and MUST reject with a RevealWrongStateError when the
// contract reverts WrongState (the permissionless-reveal race backstop).
export interface RevealChainAdapter {
  // Confirmed safe head = latest - confirmations. timestamp in unix seconds.
  safeHead(): Promise<{ blockNumber: number; timestamp: number }>;
  // getCall read pinned to `blockNumber`; null when the getter reverts (the
  // call is None / does not exist at that block).
  getCall(onchainCallId: string, blockNumber: number): Promise<RevealChainCall | null>;
  sendOpenReveal(onchainCallId: string): Promise<string>;
  sendPublishReveal(
    onchainCallId: string,
    args: {
      binaryIndex: number;
      confidenceBps: number;
      binaryIndexSignature: string;
      confidenceSignature: string;
    },
  ): Promise<string>;
  // null when the tx is not yet mined.
  getReceipt(txHash: string): Promise<RevealChainReceipt | null>;
}

export interface RevealDecryptResult {
  value: number;
  signature: string;
}

// Threshold decrypt of a public (post-openReveal) ciphertext handle. Throws
// while the threshold network is still pre-indexing the allowPublic (expected
// 403 for ~5-30s) — the worker reschedules across ticks instead of spinning.
export interface RevealDecryptor {
  decrypt(ctHash: string): Promise<RevealDecryptResult>;
}

// Marker the env adapter raises on a contract WrongState revert. Treated as a
// RECONCILE signal (re-read state next tick), never a terminal worker failure.
export class RevealWrongStateError extends Error {
  constructor(message = "contract reverted WrongState") {
    super(message);
    this.name = "RevealWrongStateError";
  }
}

export interface FhenixRevealWorkerConfig {
  db: Database.Database;
  chainId: number;
  contractAddress: string;
  chain: RevealChainAdapter;
  decryptor: RevealDecryptor;
  // Agent-exclusive grace after reveal_open_at before the worker becomes
  // eligible, measured against the SAFE BLOCK timestamp (chain time).
  graceSeconds: number;
  retryBaseMs: number;
  retryMaxMs: number;
  // How long a broadcast open/publish tx may sit without a receipt before the
  // worker re-broadcasts it. A dropped / nonce-gapped tx never yields a
  // receipt, so without this the job would wait on null forever. Re-broadcast
  // through the reveal EOA's own nonce-managed queue self-heals the stuck
  // nonce; the contract's single-reveal guard makes a redundant broadcast a
  // harmless WrongState revert (reconciled), never a double reveal.
  rebroadcastMs: number;
  maxJobsPerTick: number;
  maxConcurrency: number;
  // Worker-health escalation thresholds, measured from reveal_open_at.
  warnMs: number;
  escalateMs: number;
  now: () => Date;
  logger?: Pick<Console, "log" | "warn">;
  random?: () => number;
}

export interface FhenixRevealWorkerTickResult {
  seeded: number;
  processed: number;
  opened: number;
  published: number;
  terminal_daemon: number;
  terminal_external: number;
  quarantined: number;
  reconciled: number;
  errors: number;
}

// Retry backoff sequence (multipliers of retryBaseMs): ~5,10,20,30,60s then
// cap at retryMaxMs (5min default). NO terminal max-attempt count — the worker
// retries indefinitely; escalation is via operator alerts, not giving up.
const BACKOFF_MULTIPLIERS = [1, 2, 4, 6, 12];

export class FhenixRevealWorker {
  private readonly db: Database.Database;
  private readonly chainId: number;
  private readonly contractAddress: string;
  private readonly chain: RevealChainAdapter;
  private readonly decryptor: RevealDecryptor;
  private readonly graceSeconds: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly rebroadcastMs: number;
  private readonly maxJobsPerTick: number;
  private readonly maxConcurrency: number;
  private readonly warnMs: number;
  private readonly escalateMs: number;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly random: () => number;

  constructor(config: FhenixRevealWorkerConfig) {
    this.db = config.db;
    this.chainId = config.chainId;
    this.contractAddress = config.contractAddress.toLowerCase();
    this.chain = config.chain;
    this.decryptor = config.decryptor;
    this.graceSeconds = Math.max(0, Math.floor(config.graceSeconds));
    this.retryBaseMs = Math.max(1_000, Math.floor(config.retryBaseMs));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(config.retryMaxMs));
    this.rebroadcastMs = Math.max(this.retryBaseMs, Math.floor(config.rebroadcastMs));
    this.maxJobsPerTick = Math.max(1, Math.floor(config.maxJobsPerTick));
    this.maxConcurrency = Math.max(1, Math.floor(config.maxConcurrency));
    this.warnMs = Math.max(0, Math.floor(config.warnMs));
    this.escalateMs = Math.max(this.warnMs, Math.floor(config.escalateMs));
    this.now = config.now;
    this.logger = config.logger ?? console;
    this.random = config.random ?? Math.random;
  }

  async tick(): Promise<FhenixRevealWorkerTickResult> {
    const result: FhenixRevealWorkerTickResult = {
      seeded: 0,
      processed: 0,
      opened: 0,
      published: 0,
      terminal_daemon: 0,
      terminal_external: 0,
      quarantined: 0,
      reconciled: 0,
      errors: 0,
    };

    const head = await this.chain.safeHead();
    const tickNowIso = nowIso(this.now());

    // 1. Nominate candidates whose agent grace window has elapsed at the safe
    // head, and durably claim each as an `eligible` job (idempotent).
    const graceCutoffIso = isoFromMs(
      head.timestamp * 1_000 - this.graceSeconds * 1_000,
    );
    const candidates = fhenixSealedCallsRepo.listRevealCandidates(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      grace_cutoff_iso: graceCutoffIso,
      limit: this.maxJobsPerTick * 4,
    });
    for (const c of candidates) {
      fhenixRevealJobsRepo.ensure(this.db, {
        call_id: c.call_id,
        chain_id: this.chainId,
        contract_address: this.contractAddress,
        onchain_call_id: c.onchain_call_id,
        reveal_open_at: c.reveal_open_at,
        now: tickNowIso,
      });
      result.seeded += 1;
    }

    // 2. Worker-health escalation (never terminalizes a still-revealable call).
    this.scanHealth(tickNowIso);

    // 3. Process due jobs with bounded concurrency.
    const due = fhenixRevealJobsRepo.listDue(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      now: tickNowIso,
      limit: this.maxJobsPerTick,
    });
    await this.runBounded(due, (job) => this.processJob(job, head, result));
    result.processed = due.length;
    return result;
  }

  private async processJob(
    job: FhenixRevealJobRow,
    head: { blockNumber: number; timestamp: number },
    result: FhenixRevealWorkerTickResult,
  ): Promise<void> {
    try {
      const call = await this.chain.getCall(job.onchain_call_id, head.blockNumber);
      if (call === null) {
        // getter reverts / None at the safe head — DB/chain identity is
        // inconsistent. Quarantine + alert; keep retrying slowly (a transient
        // RPC hiccup that returned None-shaped errors can still recover).
        this.quarantine(job, "getCall returned None at safe head");
        result.quarantined += 1;
        return;
      }

      // Verify the on-chain ct handles equal the stored handles before we ever
      // act on a Sealed/Opened call.
      if (call.state === CALL_STATE.Sealed || call.state === CALL_STATE.Opened) {
        const sealed = fhenixSealedCallsRepo.byCallId(this.db, job.call_id);
        if (!sealed) {
          this.quarantine(job, "sealed call row missing");
          result.quarantined += 1;
          return;
        }
        if (
          !hexEq(call.binaryIndexCtHash, sealed.binary_index_ct_hash) ||
          !hexEq(call.confidenceCtHash, sealed.confidence_ct_hash)
        ) {
          this.quarantine(job, "on-chain ct handles do not match stored handles");
          result.quarantined += 1;
          return;
        }
      }

      switch (call.state) {
        case CALL_STATE.Revealed:
        case CALL_STATE.Invalid:
          await this.finalizeTerminal(job, result);
          return;
        case CALL_STATE.Sealed:
          await this.handleSealed(job, result);
          return;
        case CALL_STATE.Opened:
          await this.handleOpened(job, call, result);
          return;
        default:
          this.quarantine(job, `unexpected on-chain state ${call.state}`);
          result.quarantined += 1;
          return;
      }
    } catch (err) {
      if (err instanceof RevealWrongStateError) {
        // Reconcile, not fail: re-read state on the next (short) retry.
        this.reconcile(job, "WrongState — reconciling on next tick");
        result.reconciled += 1;
        return;
      }
      this.scheduleRetry(job, describeError(err));
      result.errors += 1;
    }
  }

  private async handleSealed(
    job: FhenixRevealJobRow,
    result: FhenixRevealWorkerTickResult,
  ): Promise<void> {
    // If we already broadcast an open, do not double-broadcast while it is
    // still live: wait for it to mine + confirm (state flips to Opened at the
    // safe head). Re-open only when the receipt positively reverted, OR when a
    // receiptless tx has gone stale — a dropped / nonce-gapped open never
    // yields a receipt, so re-broadcasting is the only way to unstick it.
    if (job.open_tx_hash) {
      const receipt = await this.chain.getReceipt(job.open_tx_hash);
      if (receipt && receipt.success) {
        // mined-but-not-yet-confirmed to safe head → keep waiting.
        this.reconcile(job, "awaiting open confirmation");
        return;
      }
      if (receipt === null && !this.isTxStale(job.tx_broadcast_at)) {
        // still plausibly in the mempool → keep waiting.
        this.reconcile(job, "awaiting open confirmation");
        return;
      }
      // reverted, or receiptless-and-stale → fall through and re-open below.
    }
    const txHash = await this.chain.sendOpenReveal(job.onchain_call_id);
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: "open_tx_pending",
      open_tx_hash: txHash,
      tx_broadcast_at: nowIso(this.now()),
      last_error: null,
      alert_level: job.alert_level,
      next_attempt_at: this.backoffIso(0),
      attempt_count: 0,
      now: nowIso(this.now()),
    });
    result.opened += 1;
    this.logger.log(
      `[fhenix-reveal-worker] openReveal call=${short(job.call_id)} tx=${short(txHash)}`,
    );
    // One phase transition per target per tick: stop here.
  }

  private async handleOpened(
    job: FhenixRevealJobRow,
    call: RevealChainCall,
    result: FhenixRevealWorkerTickResult,
  ): Promise<void> {
    // Reading Opened at the safe head means the open reached the configured
    // confirmation depth — safe to decrypt.
    let binValue = job.binary_index_value;
    let binSig = job.binary_index_signature;
    let confValue = job.confidence_value;
    let confSig = job.confidence_signature;

    // At most ONE decrypt attempt per missing ciphertext per pass. Persisted
    // partial results mean a settled ciphertext is never re-requested while the
    // other is still returning 403.
    if (binValue === null || binSig === null) {
      try {
        const r = await this.decryptor.decrypt(call.binaryIndexCtHash);
        binValue = r.value;
        binSig = r.signature;
      } catch (err) {
        this.persistPartialDecrypt(job, { binValue, binSig, confValue, confSig }, `binaryIndex decrypt: ${describeError(err)}`);
        return;
      }
    }
    if (confValue === null || confSig === null) {
      try {
        const r = await this.decryptor.decrypt(call.confidenceCtHash);
        confValue = r.value;
        confSig = r.signature;
      } catch (err) {
        this.persistPartialDecrypt(job, { binValue, binSig, confValue, confSig }, `confidence decrypt: ${describeError(err)}`);
        return;
      }
    }

    // Both ciphertexts decrypted. If a prior publish is still live, wait for it
    // rather than double-broadcasting. Re-publish only on a positively reverted
    // receipt, OR when a receiptless publish has gone stale (dropped /
    // nonce-gapped tx never yields a receipt — re-broadcast to unstick it).
    if (job.phase === "publish_tx_pending" && job.publish_tx_hash) {
      const receipt = await this.chain.getReceipt(job.publish_tx_hash);
      if (receipt && receipt.success) {
        this.reconcile(job, "awaiting publish confirmation");
        return;
      }
      if (receipt === null && !this.isTxStale(job.tx_broadcast_at)) {
        this.reconcile(job, "awaiting publish confirmation");
        return;
      }
      // reverted, or receiptless-and-stale → fall through and re-publish below.
    }

    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: "ready_to_publish",
      binary_index_value: binValue,
      binary_index_signature: binSig,
      confidence_value: confValue,
      confidence_signature: confSig,
      last_error: null,
      alert_level: job.alert_level,
      now: nowIso(this.now()),
    });

    const txHash = await this.chain.sendPublishReveal(job.onchain_call_id, {
      binaryIndex: binValue as number,
      confidenceBps: confValue as number,
      binaryIndexSignature: binSig as string,
      confidenceSignature: confSig as string,
    });
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: "publish_tx_pending",
      publish_tx_hash: txHash,
      tx_broadcast_at: nowIso(this.now()),
      last_error: null,
      alert_level: job.alert_level,
      next_attempt_at: this.backoffIso(0),
      attempt_count: 0,
      now: nowIso(this.now()),
    });
    result.published += 1;
    this.logger.log(
      `[fhenix-reveal-worker] publishReveal call=${short(job.call_id)} tx=${short(txHash)} bi=${binValue} conf=${confValue}`,
    );
  }

  private async finalizeTerminal(
    job: FhenixRevealJobRow,
    result: FhenixRevealWorkerTickResult,
  ): Promise<void> {
    // terminal_daemon iff OUR publish tx landed successfully; otherwise the
    // call was revealed by the agent or an external sender (terminal_external).
    // The leaderboard attribution is authoritative via receipt.from in the
    // ingestion path — this only tracks worker lifecycle.
    let phase: FhenixRevealJobPhase = "terminal_external";
    if (job.publish_tx_hash) {
      const receipt = await this.chain.getReceipt(job.publish_tx_hash);
      if (receipt && receipt.success) phase = "terminal_daemon";
    }
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase,
      last_error: null,
      alert_level: null,
      now: nowIso(this.now()),
    });
    if (phase === "terminal_daemon") result.terminal_daemon += 1;
    else result.terminal_external += 1;
  }

  // Persist whatever ciphertext(s) settled and schedule a backoff retry for the
  // one(s) still returning 403 — in a SINGLE write so the phase is not clobbered
  // by a follow-up transition reading a stale in-memory row.
  private persistPartialDecrypt(
    job: FhenixRevealJobRow,
    values: {
      binValue: number | null;
      binSig: string | null;
      confValue: number | null;
      confSig: string | null;
    },
    error: string,
  ): void {
    const anyDecrypted =
      (values.binValue !== null && values.binSig !== null) ||
      (values.confValue !== null && values.confSig !== null);
    const attempt = job.attempt_count + 1;
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: anyDecrypted ? "partially_decrypted" : "decrypt_pending",
      binary_index_value: values.binValue,
      binary_index_signature: values.binSig,
      confidence_value: values.confValue,
      confidence_signature: values.confSig,
      attempt_count: attempt,
      next_attempt_at: this.backoffIso(attempt),
      last_error: error,
      alert_level: job.alert_level,
      now: nowIso(this.now()),
    });
  }

  private scheduleRetry(job: FhenixRevealJobRow, error: string): void {
    const attempt = job.attempt_count + 1;
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: job.phase === "eligible" ? "eligible" : job.phase,
      attempt_count: attempt,
      next_attempt_at: this.backoffIso(attempt),
      last_error: error,
      alert_level: job.alert_level,
      now: nowIso(this.now()),
    });
    this.logger.warn(
      `[fhenix-reveal-worker] retry call=${short(job.call_id)} attempt=${attempt}: ${error}`,
    );
  }

  private reconcile(job: FhenixRevealJobRow, note: string): void {
    // Short, non-penalizing retry so state is re-read promptly.
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: job.phase,
      next_attempt_at: this.backoffIso(0),
      last_error: note,
      alert_level: job.alert_level,
      now: nowIso(this.now()),
    });
  }

  private quarantine(job: FhenixRevealJobRow, reason: string): void {
    fhenixRevealJobsRepo.update(this.db, job.call_id, {
      phase: "quarantined",
      last_error: reason,
      alert_level: "escalate",
      // Long, capped backoff — it may be a transient RPC anomaly.
      next_attempt_at: isoFromMs(this.now().getTime() + this.retryMaxMs),
      now: nowIso(this.now()),
    });
    this.logger.warn(
      `[fhenix-reveal-worker] QUARANTINE call=${short(job.call_id)}: ${reason}`,
    );
  }

  private scanHealth(tickNowIso: string): void {
    const warnBefore = isoFromMs(Date.parse(tickNowIso) - this.warnMs);
    const stale = fhenixRevealJobsRepo.listNonTerminalOlderThan(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      reveal_open_before: warnBefore,
      limit: 200,
    });
    const nowMs = Date.parse(tickNowIso);
    for (const job of stale) {
      const ageMs = nowMs - Date.parse(job.reveal_open_at);
      const level: "warn" | "escalate" | null =
        ageMs >= this.escalateMs ? "escalate" : ageMs >= this.warnMs ? "warn" : null;
      if (level && level !== job.alert_level && job.phase !== "quarantined") {
        fhenixRevealJobsRepo.update(this.db, job.call_id, {
          phase: job.phase,
          alert_level: level,
          last_error: job.last_error,
          now: nowIso(this.now()),
        });
        this.logger.warn(
          `[fhenix-reveal-worker] health ${level} call=${short(job.call_id)} phase=${job.phase} age=${Math.round(ageMs / 1000)}s`,
        );
      }
    }
  }

  // A broadcast tx whose receipt is still null is only re-broadcast once it has
  // been outstanding longer than rebroadcastMs. A missing watermark (a job
  // carrying a tx hash from before this column existed, or an interrupted
  // write) is treated as stale so the worker self-heals rather than waiting on
  // a receipt that may never come.
  private isTxStale(txBroadcastAt: string | null): boolean {
    if (!txBroadcastAt) return true;
    const broadcastMs = Date.parse(txBroadcastAt);
    if (Number.isNaN(broadcastMs)) return true;
    return this.now().getTime() - broadcastMs >= this.rebroadcastMs;
  }

  private backoffIso(attempt: number): string {
    const mult =
      attempt < BACKOFF_MULTIPLIERS.length
        ? BACKOFF_MULTIPLIERS[attempt]
        : BACKOFF_MULTIPLIERS[BACKOFF_MULTIPLIERS.length - 1] * 2;
    const base = Math.min(this.retryMaxMs, this.retryBaseMs * mult);
    // ±15% jitter so many jobs seeded in one tick don't retry in lockstep.
    const jittered = Math.round(base * (0.85 + this.random() * 0.3));
    const delay = Math.min(this.retryMaxMs, Math.max(this.retryBaseMs, jittered));
    return isoFromMs(this.now().getTime() + delay);
  }

  private async runBounded(
    jobs: FhenixRevealJobRow[],
    work: (job: FhenixRevealJobRow) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const count = Math.min(this.maxConcurrency, jobs.length);
    for (let i = 0; i < count; i += 1) {
      workers.push(
        (async () => {
          for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= jobs.length) return;
            await work(jobs[index]);
          }
        })(),
      );
    }
    await Promise.all(workers);
  }
}

function hexEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
