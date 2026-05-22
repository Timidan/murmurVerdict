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
import {
  fhenixEventsRepo,
  fhenixSealedCallsRepo,
} from "../verdict/db.js";
import {
  attachInvalidFhenixReveal,
  attachValidFhenixReveal,
  markMissedFhenixReveals,
} from "../verdict/fhenix-reveal-ingestion.js";
import { nowIso } from "../verdict/time.js";
import { resolveFhenixContractAddress } from "./deployments.js";

type WatchClient = {
  getBlockNumber: () => Promise<bigint>;
  getLogs: (args: {
    address: Address;
    event: typeof VERDICT_REVEALED_EVENT | typeof VERDICT_REVEAL_INVALID_EVENT;
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<readonly FhenixLog[]>;
};

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
  chainId: number;
  contractAddress: string;
  startBlock?: number;
  confirmations?: number;
  batchSize?: number;
  revealGraceSeconds?: number;
  client?: WatchClient;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface FhenixIngestTickResult {
  indexed: number;
  valid_reveals_attached: number;
  invalid_reveals_attached: number;
  missed_reveals_marked: number;
}

export class FhenixEventIngestor {
  private readonly db: Database.Database;
  private readonly verifier: FhenixEventVerifier;
  private readonly chainId: number;
  private readonly contractAddress: string;
  private readonly startBlock: number;
  private readonly confirmations: number;
  private readonly batchSize: number;
  private readonly revealGraceSeconds: number;
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
    this.revealGraceSeconds = Math.max(0, Math.floor(config.revealGraceSeconds ?? 3_600));
    this.client =
      config.client ??
      (createPublicClient({
        transport: http(config.rpcUrl),
      }) as unknown as WatchClient);
    this.now = config.now ?? (() => new Date());
    this.log = config.log ?? ((line) => console.log(line));
  }

  async tick(): Promise<FhenixIngestTickResult> {
    const valid = await this.indexEvent("VerdictRevealed", VERDICT_REVEALED_EVENT);
    const invalid = await this.indexEvent("VerdictRevealInvalid", VERDICT_REVEAL_INVALID_EVENT);
    const missed = this.markMissedReveals();
    return {
      indexed: valid.indexed + invalid.indexed,
      valid_reveals_attached: valid.attached,
      invalid_reveals_attached: invalid.attached,
      missed_reveals_marked: missed,
    };
  }

  private async indexEvent(
    eventName: "VerdictRevealed" | "VerdictRevealInvalid",
    event: typeof VERDICT_REVEALED_EVENT | typeof VERDICT_REVEAL_INVALID_EVENT,
  ): Promise<{ indexed: number; attached: number }> {
    const latest = Number(await this.client.getBlockNumber());
    const safeToBlock = latest - this.confirmations;
    if (!Number.isSafeInteger(safeToBlock) || safeToBlock < 0) {
      return { indexed: 0, attached: 0 };
    }

    const cursor = fhenixEventsRepo.getCursor(this.db, {
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      event_name: eventName,
    });
    const from = Math.max(this.startBlock, (cursor ?? this.startBlock - 1) + 1);
    if (from > safeToBlock) return { indexed: 0, attached: 0 };

    const to = Math.min(safeToBlock, from + this.batchSize - 1);
    const logs = await this.client.getLogs({
      address: this.contractAddress as Address,
      event,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });

    let attached = 0;
    for (const log of logs) {
      if (
        log.transactionHash === null ||
        log.logIndex === null ||
        log.blockNumber === null
      ) {
        continue;
      }
      const blockNumber = numberFromBigint(log.blockNumber, "block_number");
      const payload = normalizePayload(log.args);
      fhenixEventsRepo.upsertEvent(this.db, {
        chain_id: this.chainId,
        contract_address: this.contractAddress,
        event_name: eventName,
        tx_hash: log.transactionHash.toLowerCase(),
        log_index: log.logIndex,
        block_number: blockNumber,
        block_hash: log.blockHash?.toLowerCase() ?? null,
        payload_json: JSON.stringify(payload),
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
    if (logs.length > 0) {
      this.log(`[fhenix-watcher] indexed ${logs.length} ${eventName} logs through block ${to}`);
    }
    return { indexed: logs.length, attached };
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

  private markMissedReveals(): number {
    const cutoff = new Date(this.now().getTime() - this.revealGraceSeconds * 1000);
    return markMissedFhenixReveals({
      db: this.db,
      cutoffIso: nowIso(cutoff),
      terminalAt: nowIso(this.now()),
      now: this.now,
    });
  }
}

export function createFhenixEventIngestorFromEnv(
  db: Database.Database,
  verifier: FhenixEventVerifier,
): FhenixEventIngestor | null {
  const rpcUrl = process.env.FHENIX_RPC_URL?.trim();
  const rawChainId = process.env.FHENIX_CHAIN_ID?.trim();
  if (!rpcUrl || !rawChainId) return null;
  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  const contractAddress = resolveFhenixContractAddress(chainId);
  if (!contractAddress) return null;
  return new FhenixEventIngestor({
    db,
    verifier,
    rpcUrl,
    chainId,
    contractAddress,
    startBlock: envInt("FHENIX_EVENT_START_BLOCK", 0),
    confirmations: envInt("FHENIX_EVENT_CONFIRMATIONS", 2),
    batchSize: envInt("FHENIX_EVENT_BATCH_SIZE", 1_000),
    revealGraceSeconds: envInt("FHENIX_REVEAL_GRACE_SEC", 3_600),
  });
}

function normalizePayload(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
