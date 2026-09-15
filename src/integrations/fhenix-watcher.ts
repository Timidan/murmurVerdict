import type Database from "better-sqlite3";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import {
  VERDICT_REVEALED_EVENT,
  VERDICT_REVEAL_INVALID_EVENT,
  type FhenixEventVerifier,
} from "./fhenix-events.js";
import { fhenixEventsRepo } from "../verdict/repos/fhenix-event-index-repo.js";
import { fhenixSealedCallsRepo } from "../verdict/repos/fhenix-sealed-calls-repo.js";
import {
  attachInvalidFhenixReveal,
  attachValidFhenixReveal,
} from "../verdict/fhenix-reveal-ingestion.js";
import { nowIso } from "../verdict/time.js";
import {
  loadDeploymentByAddress,
  manifestPath,
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  resolveFhenixContractAddress,
} from "./deployments.js";

type WatchClient = {
  getBlockNumber: () => Promise<bigint>;
  getChainId: () => Promise<number>;
  getBlock?: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  getLogs: (args: {
    address: Address;
    event: typeof VERDICT_REVEALED_EVENT | typeof VERDICT_REVEAL_INVALID_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly FhenixLog[]>;
};

interface StreamScanResult {
  indexed: number;
  attached: number;
  reachedHead: boolean;
  error: unknown;
}

// Bound how far a single tick will chase the chain head so catch-up finishes
// in minutes (many batches per tick) without a tick running unbounded.
const DEFAULT_MAX_BATCHES_PER_TICK = 50;
const DEFAULT_TICK_TIME_BUDGET_MS = 4_000;

type FhenixLog = {
  args: Record<string, unknown>;
  transactionHash: Hex | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
};

export interface FhenixEventIngestorConfig {
  db: Database.Database;
  verifier: FhenixEventVerifier;
  rpcUrl: string;
  // Optional dedicated (e.g. archive) RPC for getLogs/head reads; falls back to rpcUrl.
  watcherRpcUrl?: string;
  chainId: number;
  contractAddress: string;
  startBlock?: number;
  confirmations?: number;
  batchSize?: number;
  maxBatchesPerTick?: number;
  tickTimeBudgetMs?: number;
  revealGraceSeconds?: number;
  /** Murmur fallback reveal EOA (lowercased). Threaded into reveal ingestion
   *  so a publish tx sent by this key is attributed to daemon_fallback. */
  daemonRevealSender?: string | null;
  client?: WatchClient;
  now: () => Date;
  log?: (line: string) => void;
}

export type FhenixEventIngestorRuntimeConfig = Omit<
  FhenixEventIngestorConfig,
  "db" | "verifier" | "client" | "now" | "log"
>;

export interface FhenixIngestTickResult {
  indexed: number;
  valid_reveals_attached: number;
  invalid_reveals_attached: number;
  missed_reveals_marked: number;
}

export class FhenixEventIngestorConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "FhenixEventIngestorConfigError";
    this.key = key;
  }
}

export class FhenixEventIngestorChainMismatchError extends Error {
  readonly expectedChainId: number;
  readonly actualChainId: number;

  constructor(expectedChainId: number, actualChainId: number) {
    super(
      `fhenix watcher RPC reports chain id ${actualChainId}, expected ${expectedChainId}; aborting tick without advancing cursors`,
    );
    this.name = "FhenixEventIngestorChainMismatchError";
    this.expectedChainId = expectedChainId;
    this.actualChainId = actualChainId;
  }
}

export class FhenixEventIngestor {
  private readonly db: Database.Database;
  private readonly verifier: FhenixEventVerifier;
  private readonly chainId: number;
  private readonly contractAddress: string;
  private readonly startBlock: number;
  private readonly confirmations: number;
  private readonly batchSize: number;
  private readonly maxBatchesPerTick: number;
  private readonly tickTimeBudgetMs: number;
  private readonly revealGraceSeconds: number;
  private readonly daemonRevealSender: string | null;
  private readonly client: WatchClient;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(config: FhenixEventIngestorConfig) {
    this.db = config.db;
    this.verifier = config.verifier;
    this.chainId = config.chainId;
    this.contractAddress = getAddress(config.contractAddress as Address).toLowerCase();
    this.startBlock = Math.max(0, Math.floor(config.startBlock ?? 0));
    this.confirmations = Math.max(0, Math.floor(config.confirmations ?? 2));
    this.batchSize = Math.max(1, Math.min(10_000, Math.floor(config.batchSize ?? 1_000)));
    this.maxBatchesPerTick = Math.max(
      1,
      Math.floor(config.maxBatchesPerTick ?? DEFAULT_MAX_BATCHES_PER_TICK),
    );
    this.tickTimeBudgetMs = Math.max(
      0,
      Math.floor(config.tickTimeBudgetMs ?? DEFAULT_TICK_TIME_BUDGET_MS),
    );
    this.revealGraceSeconds = Math.max(0, Math.floor(config.revealGraceSeconds ?? 3_600));
    this.daemonRevealSender = config.daemonRevealSender
      ? config.daemonRevealSender.toLowerCase()
      : null;
    this.client =
      config.client ??
      (createPublicClient({
        transport: http(config.watcherRpcUrl ?? config.rpcUrl),
      }) as unknown as WatchClient);
    this.now = config.now;
    this.log = config.log ?? ((line) => console.log(line));
  }

  async tick(): Promise<FhenixIngestTickResult> {
    // Never advance a cursor against the wrong chain; abort before any scan work.
    const observedChainId = Number(await this.client.getChainId());
    if (!Number.isInteger(observedChainId) || observedChainId !== this.chainId) {
      throw new FhenixEventIngestorChainMismatchError(this.chainId, observedChainId);
    }

    // Snapshot the head ONCE per tick so both event streams use the same safe block.
    const latest = Number(await this.client.getBlockNumber());
    const safeHead = latest - this.confirmations;
    const safeHeadValid = Number.isSafeInteger(safeHead) && safeHead >= 0;

    let indexed = 0;
    let attachedValid = 0;
    let attachedInvalid = 0;
    let validReachedHead = false;
    let invalidReachedHead = false;
    let scanError = false;

    if (safeHeadValid) {
      const valid = await this.indexEventStream(
        "VerdictRevealed",
        VERDICT_REVEALED_EVENT,
        safeHead,
      );
      const invalid = await this.indexEventStream(
        "VerdictRevealInvalid",
        VERDICT_REVEAL_INVALID_EVENT,
        safeHead,
      );
      indexed = valid.indexed + invalid.indexed;
      attachedValid = valid.attached;
      attachedInvalid = invalid.attached;
      validReachedHead = valid.reachedHead;
      invalidReachedHead = invalid.reachedHead;
      scanError = valid.error !== null || invalid.error !== null;
    }

    let attachError = false;
    let replayedValid = 0;
    let replayedInvalid = 0;
    try {
      replayedValid = await this.attachIndexedEvents("VerdictRevealed");
    } catch (err) {
      attachError = true;
      this.log(`[fhenix-watcher] VerdictRevealed attach error: ${describeRpcError(err)}`);
    }
    try {
      replayedInvalid = await this.attachIndexedEvents("VerdictRevealInvalid");
    } catch (err) {
      attachError = true;
      this.log(`[fhenix-watcher] VerdictRevealInvalid attach error: ${describeRpcError(err)}`);
    }

    // Overdue calls are never auto-marked `missed`: a sealed call stays revealable and
    // the reveal worker owns liveness. `missed_reveals_marked` is always 0; these flags are unused.
    void safeHeadValid;
    void validReachedHead;
    void invalidReachedHead;
    void scanError;
    void attachError;

    return {
      indexed,
      valid_reveals_attached: attachedValid + replayedValid,
      invalid_reveals_attached: attachedInvalid + replayedInvalid,
      missed_reveals_marked: 0,
    };
  }

  private async attachIndexedEvents(
    eventName: "VerdictRevealed" | "VerdictRevealInvalid",
  ): Promise<number> {
    const events = fhenixEventsRepo.listAttachableEvents(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      event_name: eventName,
    });
    let attached = 0;
    for (const event of events) {
      const log: FhenixLog = {
        args: event.payload,
        transactionHash: event.tx_hash as Hex,
        logIndex: event.log_index,
        blockNumber: BigInt(event.block_number),
        blockHash: event.block_hash as Hex | null,
      };
      if (eventName === "VerdictRevealed") {
        if (await this.attachValidReveal(log, event.block_number)) attached++;
      } else if (await this.attachInvalidReveal(log, event.block_number)) {
        attached++;
      }
    }
    return attached;
  }

  private async indexEventStream(
    eventName: "VerdictRevealed" | "VerdictRevealInvalid",
    event: typeof VERDICT_REVEALED_EVENT | typeof VERDICT_REVEAL_INVALID_EVENT,
    safeHead: number,
  ): Promise<StreamScanResult> {
    let indexed = 0;
    let attached = 0;
    let batches = 0;
    let reachedHead = false;
    const startedAtMs = Date.now();

    try {
      // Chase the head across MANY batches per tick (bounded) so a stale cursor
      // catches up in minutes, not one ~batchSize step every tick.
      while (true) {
        const cursor = fhenixEventsRepo.getCursor(this.db, {
          chain_id: this.chainId,
          contract_address: this.contractAddress,
          event_name: eventName,
        });
        const from = Math.max(this.startBlock, (cursor ?? this.startBlock - 1) + 1);
        if (from > safeHead) {
          reachedHead = true;
          if (cursor !== null && cursor > safeHead) {
            this.log(
              `[fhenix-watcher] ${eventName} cursor ${cursor} is ahead of safe head ${safeHead}; no-op this tick`,
            );
          }
          break;
        }

        const to = Math.min(safeHead, from + this.batchSize - 1);
        const logs = await this.getLogsRange(event, from, to);

        for (const log of logs) {
          if (
            log.transactionHash === null ||
            log.logIndex === null ||
            log.blockNumber === null
          ) {
            continue;
          }
          const blockNumber = numberFromBigint(log.blockNumber, "block_number");
          fhenixEventsRepo.upsertEvent(this.db, {
            chain_id: this.chainId,
            contract_address: this.contractAddress,
            event_name: eventName,
            tx_hash: log.transactionHash.toLowerCase(),
            log_index: log.logIndex,
            block_number: blockNumber,
            block_hash: log.blockHash?.toLowerCase() ?? null,
            payload: log.args,
            observed_at: nowIso(this.now()),
          });

          if (eventName === "VerdictRevealed") {
            if (await this.attachValidReveal(log, blockNumber)) attached++;
          } else if (await this.attachInvalidReveal(log, blockNumber)) {
            attached++;
          }
        }

        fhenixEventsRepo.setCursor(this.db, {
          chain_id: this.chainId,
          contract_address: this.contractAddress,
          event_name: eventName,
          last_block_number: to,
          updated_at: nowIso(this.now()),
        });
        indexed += logs.length;
        batches += 1;
        if (logs.length > 0) {
          this.log(
            `[fhenix-watcher] indexed ${logs.length} ${eventName} logs through block ${to}`,
          );
        }

        if (to >= safeHead) {
          reachedHead = true;
          break;
        }
        if (batches >= this.maxBatchesPerTick) break;
        if (Date.now() - startedAtMs >= this.tickTimeBudgetMs) break;
      }
    } catch (err) {
      // Cursors only advanced for completed batches, so no data is lost.
      this.log(
        `[fhenix-watcher] ${eventName} scan error before reaching head: ${describeRpcError(err)}`,
      );
      return { indexed, attached, reachedHead: false, error: err };
    }

    return { indexed, attached, reachedHead, error: null };
  }

  // getLogs for [from, to], halving the range and retrying ONLY when the
  // provider positively reports a range / response-size limit. A bare -32602
  // (e.g. archive-token rejection) is rethrown so we never spam-halve it.
  private async getLogsRange(
    event: typeof VERDICT_REVEALED_EVENT | typeof VERDICT_REVEAL_INVALID_EVENT,
    from: number,
    to: number,
  ): Promise<FhenixLog[]> {
    try {
      const logs = await this.client.getLogs({
        address: this.contractAddress as Address,
        event,
        fromBlock: BigInt(from),
        toBlock: BigInt(to),
      });
      return [...logs];
    } catch (err) {
      if (from >= to || !isRangeLimitError(err)) throw err;
      const mid = from + Math.floor((to - from) / 2);
      this.log(
        `[fhenix-watcher] getLogs range ${from}-${to} hit a provider limit; halving`,
      );
      const left = await this.getLogsRange(event, from, mid);
      const right = await this.getLogsRange(event, mid + 1, to);
      return [...left, ...right];
    }
  }

  private async attachValidReveal(log: FhenixLog, blockNumber: number): Promise<boolean> {
    const args = log.args as {
      callId?: Hex;
      binaryIndex?: number;
      confidenceBps?: number;
      revealedAt?: bigint;
    };
    if (!args.callId || log.transactionHash === null || log.logIndex === null) return false;
    const sealed = fhenixSealedCallsRepo.byOnchainCall(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      onchain_call_id: args.callId.toLowerCase(),
    });
    if (!sealed || sealed.reveal_status !== "pending") return false;
    const result = await attachValidFhenixReveal({
      db: this.db,
      verifier: this.verifier,
      now: this.now,
      daemonRevealSender: this.daemonRevealSender,
    }, {
      call_id: sealed.call_id,
      binary_index: Number(args.binaryIndex) as 0 | 1,
      confidence_bps: Number(args.confidenceBps),
      revealed_at: unixSecondsToIso(args.revealedAt ?? 0n),
      reveal_tx_hash: log.transactionHash,
      reveal_log_index: log.logIndex,
      reveal_block_number: blockNumber,
    });
    return result.status === 200;
  }

  private async attachInvalidReveal(log: FhenixLog, blockNumber: number): Promise<boolean> {
    const args = log.args as {
      callId?: Hex;
      binaryIndex?: number;
      confidenceBps?: number;
      reason?: number;
      revealedAt?: bigint;
    };
    if (!args.callId || log.transactionHash === null || log.logIndex === null) return false;
    const sealed = fhenixSealedCallsRepo.byOnchainCall(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      onchain_call_id: args.callId.toLowerCase(),
    });
    if (!sealed || sealed.reveal_status !== "pending") return false;

    const reason = invalidRevealReason(Number(args.reason));
    const result = await attachInvalidFhenixReveal({
      db: this.db,
      verifier: this.verifier,
      now: this.now,
      daemonRevealSender: this.daemonRevealSender,
    }, {
      call_id: sealed.call_id,
      binary_index: Number(args.binaryIndex),
      confidence_bps: Number(args.confidenceBps),
      invalid_reason: reason,
      revealed_at: unixSecondsToIso(args.revealedAt ?? 0n),
      reveal_tx_hash: log.transactionHash,
      reveal_log_index: log.logIndex,
      reveal_block_number: blockNumber,
    });
    return result.status === 200;
  }

}

export function createFhenixEventIngestorFromEnv(
  db: Database.Database,
  verifier: FhenixEventVerifier,
  opts: {
    contractAddress?: string | null;
    env?: NodeJS.ProcessEnv;
    now: () => Date;
  },
): FhenixEventIngestor | null {
  const config = loadFhenixEventIngestorConfig(opts.env, {
    contractAddress: opts.contractAddress,
  });
  return config
    ? new FhenixEventIngestor({ db, verifier, ...config, now: opts.now })
    : null;
}

export interface FhenixEventIngestorConfigOptions {
  contractAddress?: string | null;
}

export function loadFhenixEventIngestorConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: FhenixEventIngestorConfigOptions = {},
): FhenixEventIngestorRuntimeConfig | null {
  const rpcUrl = env.FHENIX_RPC_URL?.trim();
  if (!rpcUrl) return null;
  const chainIdInput = parseFhenixChainIdInput(env.FHENIX_CHAIN_ID);
  if (chainIdInput.kind === "empty") return null;
  if (chainIdInput.kind === "invalid") {
    throw new FhenixEventIngestorConfigError(
      "FHENIX_CHAIN_ID",
      "must be a positive integer",
    );
  }
  const chainId = chainIdInput.chainId;
  const contractAddress = resolveIngestorContractAddress(env, chainId, opts);
  if (!contractAddress) return null;
  const watcherRpcUrl = env.FHENIX_WATCHER_RPC_URL?.trim() || rpcUrl;
  return {
    rpcUrl,
    watcherRpcUrl,
    chainId,
    contractAddress,
    startBlock: resolveWatcherStartBlock(env, chainId, contractAddress),
    confirmations: configInt(env, "FHENIX_EVENT_CONFIRMATIONS", 2, { min: 0 }),
    batchSize: configInt(env, "FHENIX_EVENT_BATCH_SIZE", 1_000, {
      min: 1,
      max: 10_000,
    }),
    revealGraceSeconds: configInt(env, "FHENIX_REVEAL_GRACE_SEC", 3_600, {
      min: 0,
    }),
  };
}

// Start at the deploy block of the manifest entry matching the active contract (0 if none).
function resolveWatcherStartBlock(
  /** Only for manifestPath — the block itself is never read from env. */
  env: NodeJS.ProcessEnv,
  chainId: number,
  contractAddress: string,
): number {
  const entry = loadDeploymentByAddress(
    chainId,
    "MurmurSealedVerdicts",
    contractAddress,
    manifestPath(env),
  );
  return entry?.blockNumber ?? 0;
}

function resolveIngestorContractAddress(
  env: NodeJS.ProcessEnv,
  chainId: number,
  opts: FhenixEventIngestorConfigOptions,
): string | null {
  if (opts.contractAddress === undefined) {
    return resolveFhenixContractAddress(chainId, env);
  }
  const parsed = parseFhenixAddressInput(opts.contractAddress);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixEventIngestorConfigError(
    "FHENIX_SEALED_VERDICTS_ADDRESS",
    "must be a 20-byte 0x-prefixed address",
  );
}

function invalidRevealReason(value: number): "binary_index" | "confidence" | "unknown" {
  if (value === 1) return "binary_index";
  if (value === 2) return "confidence";
  return "unknown";
}

function unixSecondsToIso(value: bigint): string {
  return new Date(Number(value) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function numberFromBigint(value: bigint, field: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${field} is outside safe JavaScript range`);
  }
  return n;
}

// Flatten a (possibly viem/RPC) error into a searchable string across its
// shortMessage / details / message / numeric code and nested causes.
function describeRpcError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 5) {
    if (typeof current === "object") {
      const e = current as {
        message?: unknown;
        shortMessage?: unknown;
        details?: unknown;
        code?: unknown;
        cause?: unknown;
      };
      for (const value of [e.shortMessage, e.details, e.message, e.code]) {
        if (value !== undefined && value !== null) parts.push(String(value));
      }
      current = e.cause;
    } else {
      parts.push(String(current));
      break;
    }
    depth += 1;
  }
  return parts.join(" | ");
}

// Positively identifies range / response-size limit errors. Deliberately does
// NOT include a bare -32602 (the archive-token rejection code), so halving is
// reserved for real range limits and never spams a params/auth rejection.
const RANGE_LIMIT_PATTERN = /range|too large|max block|response size|-32701/i;

function isRangeLimitError(err: unknown): boolean {
  return RANGE_LIMIT_PATTERN.test(describeRpcError(err));
}

function configInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  opts: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (
    Number.isInteger(parsed) &&
    parsed >= opts.min &&
    (opts.max === undefined || parsed <= opts.max)
  ) {
    return parsed;
  }
  const range = opts.max === undefined
    ? `an integer >= ${opts.min}`
    : `an integer from ${opts.min} to ${opts.max}`;
  throw new FhenixEventIngestorConfigError(name, `must be ${range}`);
}
