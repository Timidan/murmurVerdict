import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { resolveFhenixContractAddress } from "./deployments.js";
import {
  FEED_PACKET_SUBMITTED_EVENT,
  SEALED_CALL_SUBMITTED_EVENT,
  fhenixMarketIdForMurmurMarket,
  type FhenixEventVerifier,
} from "./fhenix-events.js";
import {
  agentsRepo,
  feedContractsRepo,
  feedPacketsRepo,
  fhenixGatewayFeedPacketTxRepo,
  fhenixGatewayTxRepo,
  isUniqueViolation,
  marketsRepo,
  submissionsRepo,
  type FeedContractRow,
  type FeedPacketRow,
  type FhenixGatewayReceiptTelemetry,
  type FhenixGatewayFeedPacketTxAttemptRow,
  type FhenixGatewayTelemetrySummary,
  type FhenixGatewayTxAttemptRow,
  type FhenixGatewayTxStatus,
} from "../verdict/db.js";
import {
  acceptsSubmissions,
  perMarketDailyCap,
} from "../verdict/markets.js";
import { CommitmentSchema } from "../verdict/markets-core.js";
import {
  derivePolicyFromMarket,
  PolicyDerivationError,
} from "../verdict/oracle-routing.js";
import {
  ERROR_CODES,
  FeedPacketKindSchema,
  MarketIdSchema,
  SUBMISSION_LIMITS,
  VerdictError,
} from "../verdict/schema.js";
import { Hex32Schema } from "../verdict/fhenix-common.js";
import { acceptSealedCall } from "../verdict/sealed-call-acceptance.js";
import { isoFromMs, nowIso } from "../verdict/time.js";
import type { AuthIdentity } from "../verdict/auth/dispatcher.js";
import { isRuntimeKeyActive } from "../verdict/auth/accounts.js";
import {
  authorizeRuntimeKeyGatewayIntent,
  requireRuntimeKeyIdentity,
  runtimeKeyAcceptanceAuthIdentity,
} from "../verdict/auth/runtime-authorization.js";
import {
  classifyFeedPacketSla,
  inferFeedDeliveryDeadline,
  validateFeedPacketMarket,
} from "../verdict/feed-availability.js";

const COFHE_EUINT8_UTYPE = 2;
const COFHE_EUINT16_UTYPE = 3;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

const BytesHexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);

export const CofheInputSchema = z
  .object({
    ct_hash: Hex32Schema,
    security_zone: z.number().int().min(0).max(255),
    utype: z.number().int().min(0).max(255),
    signature: BytesHexSchema,
  })
  .strict();

export const GatewaySealedCallBodySchema = z
  .object({
    marketRef: CommitmentSchema.shape.marketRef,
    client_order_id: z.string().min(8).max(128),
    client_nonce: Hex32Schema,
    rationale: z.string().max(240).optional(),
    strategy_tag: z.string().min(2).max(32).optional(),
    submitted_at: z.string().datetime({ offset: false }).optional(),
    privacy_mode: z.literal("sealed_fhenix"),
    binary_index_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT8_UTYPE,
      "binary_index_input.utype must be CoFHE euint8",
    ),
    confidence_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT16_UTYPE,
      "confidence_input.utype must be CoFHE euint16",
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.rationale && !v.strategy_tag) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "rationale or strategy_tag is required",
        path: ["rationale"],
      });
    }
  });

export const GatewayFeedPacketBodySchema = z
  .object({
    packet_kind: FeedPacketKindSchema,
    market_id: MarketIdSchema.optional(),
    sequence: z.number().int().positive().optional(),
    payload_schema: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9_.-]+$/)
      .default("murmur-feed-packet-v1"),
    client_order_id: z.string().min(8).max(128),
    client_nonce: Hex32Schema,
    submitted_at: z.string().datetime({ offset: false }).optional(),
    delivery_deadline_at: z.string().datetime({ offset: false }).optional(),
    reveal_after: z.string().datetime({ offset: false }).optional(),
    privacy_mode: z.literal("sealed_fhenix"),
    action_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT8_UTYPE,
      "action_input.utype must be CoFHE euint8",
    ),
    signal_input: CofheInputSchema.refine(
      (value) => value.utype === COFHE_EUINT16_UTYPE,
      "signal_input.utype must be CoFHE euint16",
    ),
  })
  .strict();

export type GatewaySealedCallBody = z.infer<typeof GatewaySealedCallBodySchema>;
export type GatewayFeedPacketBody = z.infer<typeof GatewayFeedPacketBodySchema>;
export type CofheInput = z.infer<typeof CofheInputSchema>;

export interface FhenixGatewayClient {
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<bigint>;
  writeContract: (args: GatewayWriteContractArgs) => Promise<Hex>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<GatewayReceipt>;
}

type GatewayWriteContractArgs =
  | {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
      functionName: "submitSealedFor";
      args: readonly [
        Address,
        Hex,
        ContractCofheInput,
        ContractCofheInput,
        Hex,
      ];
    }
  | {
      address: Address;
      abi: typeof MURMUR_SEALED_VERDICTS_GATEWAY_ABI;
      functionName: "submitFeedPacketFor";
      args: readonly [
        Address,
        Hex,
        Hex,
        bigint,
        ContractCofheInput,
        ContractCofheInput,
        Hex,
      ];
    };

type GatewayReceipt = {
  status?: "success" | "reverted";
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  logs: readonly GatewayLog[];
};

type GatewayLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number;
  blockNumber?: bigint;
  transactionHash?: Hex;
};

type Measured<T> = {
  value: T;
  latencyMs: number;
};

type ConfirmationState = {
  ready: boolean;
  latestBlockNumber: number | null;
  latestBlockLatencyMs: number | null;
  confirmationsObserved: number | null;
};

type ContractCofheInput = {
  ctHash: bigint;
  securityZone: number;
  utype: number;
  signature: Hex;
};

export interface FhenixGatewayConfig {
  db: Database.Database;
  verifier: FhenixEventVerifier;
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  client: FhenixGatewayClient;
  confirmations?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  stuckAfterMs?: number;
  now?: () => Date;
}

export interface GatewaySubmitResult {
  status: 200 | 202;
  body: {
    attempt_id: string;
    status: string;
    tx_hash: string | null;
    call_id: string | null;
    next_attempt_at: string;
    idempotent_hit: boolean;
  };
}

export interface GatewayFeedPacketSubmitResult {
  status: 200 | 202;
  body: {
    attempt_id: string;
    status: string;
    tx_hash: string | null;
    packet_id: string | null;
    sequence: number;
    sla_status: string | null;
    next_attempt_at: string;
    idempotent_hit: boolean;
  };
}

export interface GatewayTickResult {
  broadcasted: number;
  confirmed: number;
  accepted: number;
  failed: number;
}

export interface GatewayOperatorAttempt {
  attempt_id: string;
  status: FhenixGatewayTxStatus;
  account_id: string;
  agent_id: string;
  runtime_key_id: string | null;
  runtime_key_policy_hash: string;
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  agent_wallet_address: string;
  market_id: string;
  market_id_hash: string;
  market_ref_protocol: string;
  market_config_version: number;
  client_order_id: string;
  client_nonce: string;
  tx_hash: string | null;
  submit_log_index: number | null;
  submit_block_number: number | null;
  onchain_call_id: string | null;
  call_id: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  broadcast_started_at: string | null;
  broadcast_latency_ms: number | null;
  receipt_observed_at: string | null;
  receipt_latency_ms: number | null;
  latest_block_latency_ms: number | null;
  receipt_status: "success" | "reverted" | null;
  receipt_block_number: number | null;
  latest_block_number: number | null;
  confirmations_observed: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_rpc_error: string | null;
  submitted_at: string;
  accepted_at: string | null;
  reveal_open_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayOperatorFeedAttempt {
  attempt_id: string;
  status: FhenixGatewayTxStatus;
  account_id: string;
  agent_id: string;
  runtime_key_id: string | null;
  runtime_key_policy_hash: string;
  chain_id: number;
  contract_address: string;
  relayer_address: string;
  agent_wallet_address: string;
  feed_id: string;
  feed_id_hash: string;
  market_id: string | null;
  market_id_hash: string;
  packet_kind: string;
  sequence: number;
  payload_schema: string;
  client_order_id: string;
  client_nonce: string;
  tx_hash: string | null;
  submit_log_index: number | null;
  submit_block_number: number | null;
  onchain_packet_id: string | null;
  packet_id: string | null;
  action_ct_hash: string | null;
  signal_ct_hash: string | null;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  broadcast_started_at: string | null;
  broadcast_latency_ms: number | null;
  receipt_observed_at: string | null;
  receipt_latency_ms: number | null;
  latest_block_latency_ms: number | null;
  receipt_status: "success" | "reverted" | null;
  receipt_block_number: number | null;
  latest_block_number: number | null;
  confirmations_observed: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  last_rpc_error: string | null;
  submitted_at: string;
  delivery_deadline_at: string | null;
  accepted_at: string | null;
  reveal_after: string;
  created_at: string;
  updated_at: string;
}

export interface GatewayOperatorSnapshot {
  served_at: string;
  configured: true;
  config: {
    chain_id: number;
    contract_address: string;
    relayer_address: string;
    confirmations: number;
    retry_base_ms: number;
    retry_max_ms: number;
    max_attempts: number;
    stuck_after_ms: number;
  };
  queues: {
    due_for_broadcast: number;
    submitted_awaiting_confirmation: number;
    confirmed_awaiting_acceptance: number;
    stuck: number;
    stale_before: string;
  };
  status_counts: Record<FhenixGatewayTxStatus, number>;
  telemetry: FhenixGatewayTelemetrySummary;
  recent_attempts: GatewayOperatorAttempt[];
  stuck_attempts: GatewayOperatorAttempt[];
  feed_queues: {
    due_for_broadcast: number;
    submitted_awaiting_confirmation: number;
    confirmed_awaiting_acceptance: number;
    stuck: number;
    stale_before: string;
  };
  feed_status_counts: Record<FhenixGatewayTxStatus, number>;
  feed_telemetry: FhenixGatewayTelemetrySummary;
  feed_recent_attempts: GatewayOperatorFeedAttempt[];
  feed_stuck_attempts: GatewayOperatorFeedAttempt[];
}

export const MURMUR_SEALED_VERDICTS_GATEWAY_ABI = parseAbi([
  "function submitSealedFor(address agent,bytes32 marketId,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) binaryIndexInput,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) confidenceInput,bytes32 clientNonce) returns (bytes32)",
  "function submitFeedPacketFor(address agent,bytes32 feedId,bytes32 marketId,uint64 revealAfter,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) actionInput,(uint256 ctHash,uint8 securityZone,uint8 utype,bytes signature) signalInput,bytes32 clientNonce) returns (bytes32)",
]);

const GATEWAY_TX_STATUSES: FhenixGatewayTxStatus[] = [
  "queued",
  "submitted",
  "confirmed",
  "accepted",
  "failed_retryable",
  "failed_terminal",
];

export class FhenixGatewayBroadcaster {
  private readonly db: Database.Database;
  private readonly verifier: FhenixEventVerifier;
  private readonly chainId: number;
  private readonly contractAddress: string;
  private readonly relayerAddress: string;
  private readonly client: FhenixGatewayClient;
  private readonly confirmations: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly stuckAfterMs: number;
  private readonly now: () => Date;

  constructor(config: FhenixGatewayConfig) {
    this.db = config.db;
    this.verifier = config.verifier;
    this.chainId = config.chainId;
    this.contractAddress = normalizeAddress(config.contractAddress);
    this.relayerAddress = normalizeAddress(config.relayerAddress);
    this.client = config.client;
    this.confirmations = Math.max(0, Math.floor(config.confirmations ?? 2));
    this.retryBaseMs = Math.max(1_000, Math.floor(config.retryBaseMs ?? 5_000));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(config.retryMaxMs ?? 120_000));
    this.maxAttempts = Math.max(1, Math.floor(config.maxAttempts ?? 5));
    this.stuckAfterMs = Math.max(60_000, Math.floor(config.stuckAfterMs ?? 10 * 60_000));
    this.now = config.now ?? (() => new Date());
  }

  async submitSealedCall(params: {
    authResult: AuthIdentity;
    bodyJson: unknown;
  }): Promise<GatewaySubmitResult> {
    const parsed = GatewaySealedCallBodySchema.safeParse(params.bodyJson);
    if (!parsed.success) {
      throw new VerdictError(
        "gateway sealed call failed schema validation",
        ERROR_CODES.schema_invalid,
        400,
        { issues: parsed.error.format() },
      );
    }
    const body = parsed.data;
    const runtimeIdentity = requireRuntimeKeyIdentity(
      params.authResult,
      "gateway submissions require X-Murmur-Runtime-Key auth",
    );
    const {
      agent_id: agentId,
      account_id: accountId,
      runtime_key: runtimeKey,
    } = runtimeIdentity;

    const existingAttempt = fhenixGatewayTxRepo.byClientOrder(
      this.db,
      agentId,
      body.client_order_id,
    );
    if (existingAttempt) {
      return resultFromAttempt(existingAttempt, true);
    }
    const existingSubmission = submissionsRepo.findByClientOrderId(
      this.db,
      agentId,
      body.client_order_id,
    );
    if (existingSubmission) {
      return {
        status: 200,
        body: {
          attempt_id: "",
          status: "accepted",
          tx_hash: null,
          call_id: existingSubmission.call_id,
          next_attempt_at: nowIso(this.now()),
          idempotent_hit: true,
        },
      };
    }

    const market = marketsRepo.get(this.db, body.marketRef.sourceId);
    if (!market) {
      throw new VerdictError(
        `unknown market: marketRef.sourceId='${body.marketRef.sourceId}'`,
        ERROR_CODES.asset_not_supported,
        404,
        { sourceId: body.marketRef.sourceId },
      );
    }
    const expectedProtocol = market.adapter_id ?? "native-price";
    if (body.marketRef.protocol !== expectedProtocol) {
      throw new VerdictError(
        `marketRef.protocol mismatch: agent supplied '${body.marketRef.protocol}' but market '${market.market_id}' is owned by adapter '${expectedProtocol}'`,
        ERROR_CODES.schema_invalid,
        400,
        {
          supplied_protocol: body.marketRef.protocol,
          market_adapter_id: expectedProtocol,
          sourceId: body.marketRef.sourceId,
        },
      );
    }
    // Rate-limit check + queued-attempt insert must be atomic. Without the
    // IMMEDIATE transaction below, two concurrent submissions can both pass
    // the count check before either inserts — the relayer then burns gas
    // on attempts that violate the policy. The IMMEDIATE lock serializes
    // count-then-insert across writers; the broadcast (async) stays outside
    // because better-sqlite3 transactions are sync-only.
    const ts = nowIso(this.now());
    const attempt = {
      attempt_id: randomUUID(),
      status: "queued" as const,
      runtime_key_id: runtimeKey.runtime_key_id,
      runtime_key_policy_hash: runtimeKey.policy_hash,
      runtime_key_policy_json: runtimeKey.policy_json,
      account_id: accountId,
      agent_id: agentId,
      chain_id: this.chainId,
      contract_address: this.contractAddress,
      relayer_address: this.relayerAddress,
      agent_wallet_address: normalizeAddress(runtimeKey.controller_wallet_address),
      market_id: market.market_id,
      market_id_hash: fhenixMarketIdForMurmurMarket(market.market_id),
      market_ref_protocol: body.marketRef.protocol,
      market_config_version: body.marketRef.configVersion,
      client_order_id: body.client_order_id,
      client_nonce: body.client_nonce.toLowerCase(),
      submitted_at: body.submitted_at ?? ts,
      rationale: body.rationale ?? null,
      strategy_tag: body.strategy_tag ?? null,
      binary_index_input_json: JSON.stringify(body.binary_index_input),
      confidence_input_json: JSON.stringify(body.confidence_input),
      next_attempt_at: ts,
      created_at: ts,
      updated_at: ts,
    };

    let idempotentReturn: FhenixGatewayTxAttemptRow | null = null;
    let idempotentSubmissionCallId: string | null = null;
    const reserveAndInsert = this.db.transaction(() => {
      // Re-check inside the lock: a competing process may have inserted
      // the same (agent_id, client_order_id) attempt OR already promoted
      // it to an accepted submission between our earlier pre-lock
      // idempotency check and this point.
      const competing = fhenixGatewayTxRepo.byClientOrder(
        this.db,
        agentId,
        body.client_order_id,
      );
      if (competing) {
        idempotentReturn = competing;
        return;
      }
      const competingSubmission = submissionsRepo.findByClientOrderId(
        this.db,
        agentId,
        body.client_order_id,
      );
      if (competingSubmission) {
        idempotentSubmissionCallId = competingSubmission.call_id;
        return;
      }
      authorizeRuntimeKeyGatewayIntent(
        this.db,
        runtimeIdentity,
        {
          kind: "sealed_call",
          chain_id: this.chainId,
          market_id: market.market_id,
        },
        { now: this.now },
      );
      preflightMarketAndRateLimits(this.db, agentId, market, this.now);
      try {
        fhenixGatewayTxRepo.insert(this.db, attempt);
      } catch (err) {
        if (isUniqueViolation(err)) {
          const row = fhenixGatewayTxRepo.byClientOrder(
            this.db,
            agentId,
            body.client_order_id,
          );
          if (row) {
            idempotentReturn = row;
            return;
          }
        }
        throw err;
      }
    });
    reserveAndInsert.immediate();

    if (idempotentReturn) {
      return resultFromAttempt(idempotentReturn, true);
    }
    if (idempotentSubmissionCallId !== null) {
      const callId: string = idempotentSubmissionCallId;
      return {
        status: 200,
        body: {
          attempt_id: "",
          status: "accepted",
          tx_hash: null,
          call_id: callId,
          next_attempt_at: nowIso(this.now()),
          idempotent_hit: true,
        },
      };
    }

    await this.broadcastAttempt(attempt.attempt_id);
    const row = fhenixGatewayTxRepo.byId(this.db, attempt.attempt_id);
    if (!row) throw new Error(`gateway attempt missing after insert: ${attempt.attempt_id}`);
    return resultFromAttempt(row, false);
  }

  async submitFeedPacket(params: {
    authResult: AuthIdentity;
    feedId: string;
    bodyJson: unknown;
  }): Promise<GatewayFeedPacketSubmitResult> {
    const parsed = GatewayFeedPacketBodySchema.safeParse(params.bodyJson);
    if (!parsed.success) {
      throw new VerdictError(
        "gateway feed packet failed schema validation",
        ERROR_CODES.schema_invalid,
        400,
        { issues: parsed.error.format() },
      );
    }
    const body = parsed.data;
    const runtimeIdentity = requireRuntimeKeyIdentity(
      params.authResult,
      "gateway feed packets require X-Murmur-Runtime-Key auth",
    );
    const {
      agent_id: agentId,
      account_id: accountId,
      runtime_key: runtimeKey,
    } = runtimeIdentity;

    const feed = feedContractsRepo.byId(this.db, params.feedId);
    if (!feed) {
      throw new VerdictError(
        "feed not found",
        ERROR_CODES.asset_not_supported,
        404,
        { feed_id: params.feedId },
      );
    }
    if (feed.agent_id !== agentId) {
      throw new VerdictError(
        "agent does not own this feed",
        ERROR_CODES.agent_not_owned_by_account,
        403,
        { feed_id: params.feedId },
      );
    }
    if (feed.status !== "listed") {
      throw new VerdictError(
        `feed status=${feed.status} does not accept Gateway packets`,
        ERROR_CODES.schema_invalid,
        409,
        { feed_id: params.feedId, status: feed.status },
      );
    }
    authorizeRuntimeKeyGatewayIntent(
      this.db,
      runtimeIdentity,
      {
        kind: "feed_packet",
        chain_id: this.chainId,
        market_id: body.market_id ?? null,
      },
      { now: this.now },
    );
    validateFeedPacketMarket(this.db, feed, body.market_id ?? null);

    const existingAttempt = fhenixGatewayFeedPacketTxRepo.byClientOrder(
      this.db,
      agentId,
      feed.feed_id,
      body.client_order_id,
    );
    if (existingAttempt) {
      return feedResultFromAttempt(existingAttempt, true, this.db);
    }

    const now = this.now();
    const ts = nowIso(now);
    const revealAfter = deriveFeedRevealAfter(feed, body.reveal_after, now);
    const revealAfterMs = Date.parse(revealAfter);
    if (!Number.isFinite(revealAfterMs) || revealAfterMs <= now.getTime()) {
      throw new VerdictError(
        "feed packet reveal_after must be in the future",
        ERROR_CODES.schema_invalid,
        400,
        { reveal_after: revealAfter },
      );
    }

    const attemptId = randomUUID();
    // Mirrors the sealed-call path: sequence-allocation + insert must be
    // atomic under an IMMEDIATE lock so two concurrent submitFeedPacket
    // calls don't both pick the same sequence number for a feed. The
    // accepted-packet UNIQUE(feed_id, sequence) constraint would still
    // reject one, but only after the relayer has already broadcast.
    let idempotentFeedReturn: ReturnType<typeof fhenixGatewayFeedPacketTxRepo.byClientOrder> | null = null;
    try {
      const reserveFeedAttempt = this.db.transaction(() => {
        const competing = fhenixGatewayFeedPacketTxRepo.byClientOrder(
          this.db,
          agentId,
          feed.feed_id,
          body.client_order_id,
        );
        if (competing) {
          idempotentFeedReturn = competing;
          return;
        }
        const sequence = body.sequence ?? Math.max(
          feedPacketsRepo.nextSequence(this.db, feed.feed_id),
          fhenixGatewayFeedPacketTxRepo.nextSequence(this.db, feed.feed_id),
        );
        const latest = feedPacketsRepo.latestForFeed(this.db, feed.feed_id);
        const deadline = body.delivery_deadline_at ??
          inferFeedDeliveryDeadline(feed, latest, sequence);
        fhenixGatewayFeedPacketTxRepo.insert(this.db, {
          attempt_id: attemptId,
          status: "queued",
          runtime_key_id: runtimeKey.runtime_key_id,
          runtime_key_policy_hash: runtimeKey.policy_hash,
          runtime_key_policy_json: runtimeKey.policy_json,
          account_id: accountId,
          agent_id: agentId,
          chain_id: this.chainId,
          contract_address: this.contractAddress,
          relayer_address: this.relayerAddress,
          agent_wallet_address: normalizeAddress(runtimeKey.controller_wallet_address),
          feed_id: feed.feed_id,
          feed_id_hash: fhenixFeedIdForMurmurFeed(feed.feed_id),
          market_id: body.market_id ?? null,
          market_id_hash: body.market_id ? fhenixMarketIdForMurmurMarket(body.market_id) : ZERO_BYTES32,
          packet_kind: body.packet_kind,
          sequence,
          payload_schema: body.payload_schema,
          client_order_id: body.client_order_id,
          client_nonce: body.client_nonce.toLowerCase(),
          submitted_at: body.submitted_at ?? ts,
          delivery_deadline_at: deadline,
          reveal_after: revealAfter,
          action_input_json: JSON.stringify(body.action_input),
          signal_input_json: JSON.stringify(body.signal_input),
          next_attempt_at: ts,
          created_at: ts,
          updated_at: ts,
        });
      });
      reserveFeedAttempt.immediate();
    } catch (err) {
      if (isUniqueViolation(err)) {
        const row = fhenixGatewayFeedPacketTxRepo.byClientOrder(
          this.db,
          agentId,
          feed.feed_id,
          body.client_order_id,
        );
        if (row) return feedResultFromAttempt(row, true, this.db);
      }
      throw err;
    }
    if (idempotentFeedReturn) {
      return feedResultFromAttempt(idempotentFeedReturn, true, this.db);
    }

    await this.broadcastFeedPacketAttempt(attemptId);
    const row = fhenixGatewayFeedPacketTxRepo.byId(this.db, attemptId);
    if (!row) throw new Error(`gateway feed attempt missing after insert: ${attemptId}`);
    return feedResultFromAttempt(row, false, this.db);
  }

  async tick(): Promise<GatewayTickResult> {
    let broadcasted = 0;
    let confirmed = 0;
    let accepted = 0;
    let failed = 0;
    for (const attempt of fhenixGatewayTxRepo.listDueForBroadcast(
      this.db,
      nowIso(this.now()),
    )) {
      const before = attempt.attempt_count;
      await this.broadcastAttempt(attempt.attempt_id);
      const after = fhenixGatewayTxRepo.byId(this.db, attempt.attempt_id);
      if (after?.status === "submitted" && after.attempt_count > before) broadcasted++;
      if (after?.status === "failed_terminal") failed++;
    }
    for (const attempt of fhenixGatewayTxRepo.listSubmittedForConfirmation(this.db)) {
      const ok = await this.confirmAttempt(attempt);
      if (ok) {
        confirmed++;
        const after = fhenixGatewayTxRepo.byId(this.db, attempt.attempt_id);
        if (after?.status === "accepted") accepted++;
      }
    }
    for (const attempt of fhenixGatewayTxRepo.listConfirmedForAcceptance(this.db)) {
      const ok = await this.acceptConfirmedAttempt(attempt);
      if (ok) accepted++;
      else failed++;
    }
    for (const attempt of fhenixGatewayFeedPacketTxRepo.listDueForBroadcast(
      this.db,
      nowIso(this.now()),
    )) {
      const before = attempt.attempt_count;
      await this.broadcastFeedPacketAttempt(attempt.attempt_id);
      const after = fhenixGatewayFeedPacketTxRepo.byId(this.db, attempt.attempt_id);
      if (after?.status === "submitted" && after.attempt_count > before) broadcasted++;
      if (after?.status === "failed_terminal") failed++;
    }
    for (const attempt of fhenixGatewayFeedPacketTxRepo.listSubmittedForConfirmation(this.db)) {
      const ok = await this.confirmFeedPacketAttempt(attempt);
      if (ok) {
        confirmed++;
        const after = fhenixGatewayFeedPacketTxRepo.byId(this.db, attempt.attempt_id);
        if (after?.status === "accepted") accepted++;
      }
    }
    for (const attempt of fhenixGatewayFeedPacketTxRepo.listConfirmedForAcceptance(this.db)) {
      const ok = await this.acceptConfirmedFeedPacketAttempt(attempt);
      if (ok) accepted++;
      else failed++;
    }
    return { broadcasted, confirmed, accepted, failed };
  }

  operatorSnapshot(opts: {
    status?: FhenixGatewayTxStatus;
    limit?: number;
    stuckAfterMs?: number;
  } = {}): GatewayOperatorSnapshot {
    const servedAt = nowIso(this.now());
    const stuckAfterMs = Math.max(
      60_000,
      Math.floor(opts.stuckAfterMs ?? this.stuckAfterMs),
    );
    const staleBefore = isoFromMs(this.now().getTime() - stuckAfterMs);
    const statusCounts = Object.fromEntries(
      GATEWAY_TX_STATUSES.map((status) => [status, 0]),
    ) as Record<FhenixGatewayTxStatus, number>;
    for (const row of fhenixGatewayTxRepo.statusCounts(this.db)) {
      statusCounts[row.status] = row.count;
    }
    const feedStatusCounts = Object.fromEntries(
      GATEWAY_TX_STATUSES.map((status) => [status, 0]),
    ) as Record<FhenixGatewayTxStatus, number>;
    for (const row of fhenixGatewayFeedPacketTxRepo.statusCounts(this.db)) {
      feedStatusCounts[row.status] = row.count;
    }
    const stuck = fhenixGatewayTxRepo.listStuck(this.db, {
      stale_before: staleBefore,
      limit: opts.limit ?? 50,
    });
    const feedStuck = fhenixGatewayFeedPacketTxRepo.listStuck(this.db, {
      stale_before: staleBefore,
      limit: opts.limit ?? 50,
    });
    return {
      served_at: servedAt,
      configured: true,
      config: {
        chain_id: this.chainId,
        contract_address: this.contractAddress,
        relayer_address: this.relayerAddress,
        confirmations: this.confirmations,
        retry_base_ms: this.retryBaseMs,
        retry_max_ms: this.retryMaxMs,
        max_attempts: this.maxAttempts,
        stuck_after_ms: stuckAfterMs,
      },
      queues: {
        due_for_broadcast: fhenixGatewayTxRepo.countDueForBroadcast(this.db, servedAt),
        submitted_awaiting_confirmation: fhenixGatewayTxRepo.countSubmittedForConfirmation(this.db),
        confirmed_awaiting_acceptance: fhenixGatewayTxRepo.countConfirmedForAcceptance(this.db),
        stuck: stuck.length,
        stale_before: staleBefore,
	      },
	      status_counts: statusCounts,
	      telemetry: fhenixGatewayTxRepo.telemetrySummary(this.db),
	      recent_attempts: fhenixGatewayTxRepo
	        .listRecent(this.db, { status: opts.status, limit: opts.limit ?? 50 })
	        .map(operatorAttempt),
      stuck_attempts: stuck.map(operatorAttempt),
      feed_queues: {
        due_for_broadcast: fhenixGatewayFeedPacketTxRepo.countDueForBroadcast(this.db, servedAt),
        submitted_awaiting_confirmation: fhenixGatewayFeedPacketTxRepo.countSubmittedForConfirmation(this.db),
        confirmed_awaiting_acceptance: fhenixGatewayFeedPacketTxRepo.countConfirmedForAcceptance(this.db),
        stuck: feedStuck.length,
        stale_before: staleBefore,
	      },
	      feed_status_counts: feedStatusCounts,
	      feed_telemetry: fhenixGatewayFeedPacketTxRepo.telemetrySummary(this.db),
	      feed_recent_attempts: fhenixGatewayFeedPacketTxRepo
	        .listRecent(this.db, { status: opts.status, limit: opts.limit ?? 50 })
	        .map(operatorFeedAttempt),
      feed_stuck_attempts: feedStuck.map(operatorFeedAttempt),
    };
  }

  async retryAttemptNow(
    attemptId: string,
  ): Promise<GatewaySubmitResult | GatewayFeedPacketSubmitResult> {
    const attempt = fhenixGatewayTxRepo.byId(this.db, attemptId);
    if (attempt) {
      if (!["queued", "failed_retryable"].includes(attempt.status)) {
        throw new VerdictError(
          `cannot retry gateway attempt in status=${attempt.status}`,
          ERROR_CODES.schema_invalid,
          409,
          {
            attempt_id: attempt.attempt_id,
            status: attempt.status,
          },
        );
      }
      fhenixGatewayTxRepo.markRetryNow(this.db, {
        attempt_id: attempt.attempt_id,
        next_attempt_at: nowIso(this.now()),
        updated_at: nowIso(this.now()),
      });
      await this.broadcastAttempt(attempt.attempt_id);
      const row = fhenixGatewayTxRepo.byId(this.db, attempt.attempt_id);
      if (!row) throw new Error(`gateway attempt missing after retry: ${attempt.attempt_id}`);
      return resultFromAttempt(row, false);
    }
    const feedAttempt = fhenixGatewayFeedPacketTxRepo.byId(this.db, attemptId);
    if (!feedAttempt) {
      throw new VerdictError(
        `unknown Fhenix Gateway attempt: ${attemptId}`,
        ERROR_CODES.asset_not_supported,
        404,
      );
    }
    if (!["queued", "failed_retryable"].includes(feedAttempt.status)) {
      throw new VerdictError(
        `cannot retry gateway feed attempt in status=${feedAttempt.status}`,
        ERROR_CODES.schema_invalid,
        409,
        {
          attempt_id: feedAttempt.attempt_id,
          status: feedAttempt.status,
        },
      );
    }
    fhenixGatewayFeedPacketTxRepo.markRetryNow(this.db, {
      attempt_id: feedAttempt.attempt_id,
      next_attempt_at: nowIso(this.now()),
      updated_at: nowIso(this.now()),
    });
    await this.broadcastFeedPacketAttempt(feedAttempt.attempt_id);
    const row = fhenixGatewayFeedPacketTxRepo.byId(this.db, feedAttempt.attempt_id);
    if (!row) throw new Error(`gateway feed attempt missing after retry: ${feedAttempt.attempt_id}`);
    return feedResultFromAttempt(row, false, this.db);
  }

  private async broadcastAttempt(attemptId: string): Promise<void> {
    const attempt = fhenixGatewayTxRepo.byId(this.db, attemptId);
    if (!attempt || !["queued", "failed_retryable"].includes(attempt.status)) return;
    if (
      attempt.runtime_key_id &&
      !isRuntimeKeyActive(this.db, attempt.runtime_key_id, { now: this.now })
    ) {
      fhenixGatewayTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: "Runtime Key revoked or expired before broadcast",
        updated_at: nowIso(this.now()),
      });
      return;
    }
    if (attempt.attempt_count >= this.maxAttempts) {
      fhenixGatewayTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: `Gateway relay exceeded max attempts (${this.maxAttempts})`,
        updated_at: nowIso(this.now()),
      });
      return;
    }
    const broadcastStartedAt = nowIso(this.now());
    try {
      const { value: txHash, latencyMs } = await measure(() => this.client.writeContract({
        address: this.contractAddress as Address,
        abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
        functionName: "submitSealedFor",
        args: [
          attempt.agent_wallet_address as Address,
          attempt.market_id_hash as Hex,
          contractInput(JSON.parse(attempt.binary_index_input_json) as CofheInput),
          contractInput(JSON.parse(attempt.confidence_input_json) as CofheInput),
          attempt.client_nonce as Hex,
        ],
      }));
      fhenixGatewayTxRepo.markSubmitted(this.db, {
        attempt_id: attempt.attempt_id,
        tx_hash: txHash.toLowerCase(),
        next_attempt_at: isoFromMs(this.now().getTime() + this.retryMaxMs),
        updated_at: nowIso(this.now()),
        broadcast_started_at: broadcastStartedAt,
        broadcast_latency_ms: latencyMs,
      });
    } catch (err) {
      fhenixGatewayTxRepo.markRetryableFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: errorMessage(err),
        next_attempt_at: this.nextRetryAt(attempt.attempt_count + 1),
        updated_at: nowIso(this.now()),
        broadcast_started_at: broadcastStartedAt,
        broadcast_latency_ms: null,
      });
    }
  }

  private async broadcastFeedPacketAttempt(attemptId: string): Promise<void> {
    const attempt = fhenixGatewayFeedPacketTxRepo.byId(this.db, attemptId);
    if (!attempt || !["queued", "failed_retryable"].includes(attempt.status)) return;
    if (
      attempt.runtime_key_id &&
      !isRuntimeKeyActive(this.db, attempt.runtime_key_id, { now: this.now })
    ) {
      fhenixGatewayFeedPacketTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: "Runtime Key revoked or expired before feed packet broadcast",
        updated_at: nowIso(this.now()),
      });
      return;
    }
    if (attempt.attempt_count >= this.maxAttempts) {
      fhenixGatewayFeedPacketTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: `Gateway feed relay exceeded max attempts (${this.maxAttempts})`,
        updated_at: nowIso(this.now()),
      });
      return;
    }
    const broadcastStartedAt = nowIso(this.now());
    try {
      const { value: txHash, latencyMs } = await measure(() => this.client.writeContract({
        address: this.contractAddress as Address,
        abi: MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
        functionName: "submitFeedPacketFor",
        args: [
          attempt.agent_wallet_address as Address,
          attempt.feed_id_hash as Hex,
          attempt.market_id_hash as Hex,
          BigInt(Math.floor(Date.parse(attempt.reveal_after) / 1000)),
          contractInput(JSON.parse(attempt.action_input_json) as CofheInput),
          contractInput(JSON.parse(attempt.signal_input_json) as CofheInput),
          attempt.client_nonce as Hex,
        ],
      }));
      fhenixGatewayFeedPacketTxRepo.markSubmitted(this.db, {
        attempt_id: attempt.attempt_id,
        tx_hash: txHash.toLowerCase(),
        next_attempt_at: isoFromMs(this.now().getTime() + this.retryMaxMs),
        updated_at: nowIso(this.now()),
        broadcast_started_at: broadcastStartedAt,
        broadcast_latency_ms: latencyMs,
      });
    } catch (err) {
      fhenixGatewayFeedPacketTxRepo.markRetryableFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: errorMessage(err),
        next_attempt_at: this.nextRetryAt(attempt.attempt_count + 1),
        updated_at: nowIso(this.now()),
        broadcast_started_at: broadcastStartedAt,
        broadcast_latency_ms: null,
      });
    }
  }

	  private async confirmAttempt(attempt: FhenixGatewayTxAttemptRow): Promise<boolean> {
	    if (!attempt.tx_hash) return false;
	    const receiptObservedAt = nowIso(this.now());
	    let measuredReceipt: Measured<GatewayReceipt>;
	    try {
	      measuredReceipt = await measure(() =>
	        this.client.getTransactionReceipt({ hash: attempt.tx_hash as Hex }),
	      );
	    } catch (err) {
	      fhenixGatewayTxRepo.recordRpcError(this.db, {
	        attempt_id: attempt.attempt_id,
	        receipt_observed_at: receiptObservedAt,
	        receipt_latency_ms: null,
	        last_rpc_error: errorMessage(err),
	      });
	      return false;
	    }
	    const receipt = measuredReceipt.value;
	    let confirmation: ConfirmationState;
	    try {
	      confirmation = await this.confirmationState(receipt);
	    } catch (err) {
	      fhenixGatewayTxRepo.recordReceiptTelemetry(this.db, receiptTelemetry({
	        attempt_id: attempt.attempt_id,
	        receipt,
	        receipt_observed_at: receiptObservedAt,
	        receipt_latency_ms: measuredReceipt.latencyMs,
	        confirmation: null,
	        last_rpc_error: errorMessage(err),
	      }));
	      return false;
	    }
	    fhenixGatewayTxRepo.recordReceiptTelemetry(this.db, receiptTelemetry({
	      attempt_id: attempt.attempt_id,
	      receipt,
	      receipt_observed_at: receiptObservedAt,
	      receipt_latency_ms: measuredReceipt.latencyMs,
	      confirmation,
	      last_rpc_error: null,
	    }));
	    if (receipt.status === "reverted") {
	      fhenixGatewayTxRepo.markTerminalFailure(this.db, {
	        attempt_id: attempt.attempt_id,
	        last_error: "Fhenix Gateway relay transaction reverted",
	        updated_at: nowIso(this.now()),
	      });
	      return false;
	    }
	    if (!confirmation.ready) return false;
	    const event = this.extractSubmitEvent(attempt, receipt);
	    if (!event) return false;
    fhenixGatewayTxRepo.markConfirmed(this.db, {
      attempt_id: attempt.attempt_id,
      submit_log_index: event.logIndex,
      submit_block_number: event.blockNumber,
      onchain_call_id: event.onchain_call_id,
      binary_index_ct_hash: event.binary_index_ct_hash,
      confidence_ct_hash: event.confidence_ct_hash,
      accepted_at: event.accepted_at,
      reveal_open_at: event.reveal_open_at,
      updated_at: nowIso(this.now()),
    });
    const confirmed = fhenixGatewayTxRepo.byId(this.db, attempt.attempt_id);
    return confirmed ? this.acceptConfirmedAttempt(confirmed) : true;
  }

	  private async confirmFeedPacketAttempt(
	    attempt: FhenixGatewayFeedPacketTxAttemptRow,
	  ): Promise<boolean> {
	    if (!attempt.tx_hash) return false;
	    const receiptObservedAt = nowIso(this.now());
	    let measuredReceipt: Measured<GatewayReceipt>;
	    try {
	      measuredReceipt = await measure(() =>
	        this.client.getTransactionReceipt({ hash: attempt.tx_hash as Hex }),
	      );
	    } catch (err) {
	      fhenixGatewayFeedPacketTxRepo.recordRpcError(this.db, {
	        attempt_id: attempt.attempt_id,
	        receipt_observed_at: receiptObservedAt,
	        receipt_latency_ms: null,
	        last_rpc_error: errorMessage(err),
	      });
	      return false;
	    }
	    const receipt = measuredReceipt.value;
	    let confirmation: ConfirmationState;
	    try {
	      confirmation = await this.confirmationState(receipt);
	    } catch (err) {
	      fhenixGatewayFeedPacketTxRepo.recordReceiptTelemetry(this.db, receiptTelemetry({
	        attempt_id: attempt.attempt_id,
	        receipt,
	        receipt_observed_at: receiptObservedAt,
	        receipt_latency_ms: measuredReceipt.latencyMs,
	        confirmation: null,
	        last_rpc_error: errorMessage(err),
	      }));
	      return false;
	    }
	    fhenixGatewayFeedPacketTxRepo.recordReceiptTelemetry(this.db, receiptTelemetry({
	      attempt_id: attempt.attempt_id,
	      receipt,
	      receipt_observed_at: receiptObservedAt,
	      receipt_latency_ms: measuredReceipt.latencyMs,
	      confirmation,
	      last_rpc_error: null,
	    }));
	    if (receipt.status === "reverted") {
	      fhenixGatewayFeedPacketTxRepo.markTerminalFailure(this.db, {
	        attempt_id: attempt.attempt_id,
	        last_error: "Fhenix Gateway feed relay transaction reverted",
	        updated_at: nowIso(this.now()),
	      });
	      return false;
	    }
	    if (!confirmation.ready) return false;
	    const event = this.extractFeedPacketEvent(attempt, receipt);
    if (!event) return false;
    fhenixGatewayFeedPacketTxRepo.markConfirmed(this.db, {
      attempt_id: attempt.attempt_id,
      submit_log_index: event.logIndex,
      submit_block_number: event.blockNumber,
      onchain_packet_id: event.onchain_packet_id,
      action_ct_hash: event.action_ct_hash,
      signal_ct_hash: event.signal_ct_hash,
      accepted_at: event.accepted_at,
      updated_at: nowIso(this.now()),
    });
    const confirmed = fhenixGatewayFeedPacketTxRepo.byId(this.db, attempt.attempt_id);
    return confirmed ? this.acceptConfirmedFeedPacketAttempt(confirmed) : true;
  }

  private async acceptConfirmedAttempt(attempt: FhenixGatewayTxAttemptRow): Promise<boolean> {
    if (
      !attempt.tx_hash ||
      attempt.submit_log_index === null ||
      !attempt.onchain_call_id ||
      !attempt.binary_index_ct_hash ||
      !attempt.confidence_ct_hash ||
      !attempt.accepted_at ||
      !attempt.reveal_open_at
    ) {
      fhenixGatewayTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: "confirmed gateway attempt is missing event metadata",
        updated_at: nowIso(this.now()),
      });
      return false;
    }
    const market = marketsRepo.get(this.db, attempt.market_id);
    if (!market) {
      fhenixGatewayTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: `confirmed gateway attempt references unknown market ${attempt.market_id}`,
        updated_at: nowIso(this.now()),
      });
      return false;
    }
    try {
      const result = await acceptSealedCall({
        db: this.db,
        authResult: runtimeKeyAcceptanceAuthIdentity({
          agent_id: attempt.agent_id,
          account_id: attempt.account_id,
          runtime_key_id: attempt.runtime_key_id,
          runtime_key_policy_json: attempt.runtime_key_policy_json,
          runtime_key_policy_hash: attempt.runtime_key_policy_hash,
          controller_wallet_address: attempt.agent_wallet_address,
          controller_chain_id: `eip155:${attempt.chain_id}`,
        }),
        market,
        client_order_id: attempt.client_order_id,
        submitted_at: attempt.submitted_at,
        rationale: attempt.rationale ?? undefined,
        strategy_tag: attempt.strategy_tag ?? undefined,
        verifiedSubmit: {
          chain_id: attempt.chain_id,
          contract_address: attempt.contract_address,
          onchain_call_id: attempt.onchain_call_id,
          submit_tx_hash: attempt.tx_hash,
          submit_log_index: attempt.submit_log_index,
          binary_index_ct_hash: attempt.binary_index_ct_hash,
          confidence_ct_hash: attempt.confidence_ct_hash,
          accepted_at: attempt.accepted_at,
          reveal_open_at: attempt.reveal_open_at,
          agent_wallet: attempt.agent_wallet_address,
          market_id_hash: attempt.market_id_hash,
          client_nonce: attempt.client_nonce,
        },
        now: this.now,
      });
      fhenixGatewayTxRepo.markAccepted(this.db, {
        attempt_id: attempt.attempt_id,
        call_id: result.body.call_id,
        updated_at: nowIso(this.now()),
      });
      return true;
    } catch (err) {
      fhenixGatewayTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: errorMessage(err),
        updated_at: nowIso(this.now()),
      });
      return false;
    }
  }

  private async acceptConfirmedFeedPacketAttempt(
    attempt: FhenixGatewayFeedPacketTxAttemptRow,
  ): Promise<boolean> {
    if (
      !attempt.tx_hash ||
      attempt.submit_log_index === null ||
      !attempt.onchain_packet_id ||
      !attempt.action_ct_hash ||
      !attempt.signal_ct_hash ||
      !attempt.accepted_at
    ) {
      fhenixGatewayFeedPacketTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: "confirmed gateway feed packet attempt is missing event metadata",
        updated_at: nowIso(this.now()),
      });
      return false;
    }
    try {
      const existing = feedPacketsRepo.byFhenixEvent(this.db, {
        chain_id: attempt.chain_id,
        contract_address: attempt.contract_address,
        onchain_packet_id: attempt.onchain_packet_id,
      });
      if (existing) {
        fhenixGatewayFeedPacketTxRepo.markAccepted(this.db, {
          attempt_id: attempt.attempt_id,
          packet_id: existing.packet_id,
          updated_at: nowIso(this.now()),
        });
        return true;
      }
      const packetId = randomUUID();
      const slaStatus = classifyFeedPacketSla(
        attempt.accepted_at,
        attempt.delivery_deadline_at,
      );
      this.db.transaction(() => {
        feedPacketsRepo.insert(this.db, {
          packet_id: packetId,
          feed_id: attempt.feed_id,
          agent_id: attempt.agent_id,
          market_id: attempt.market_id,
          packet_kind: attempt.packet_kind,
          sequence: attempt.sequence,
          payload_schema: attempt.payload_schema,
          submitted_at: attempt.submitted_at,
          accepted_at: attempt.accepted_at!,
          reveal_after: attempt.reveal_after,
          delivery_deadline_at: attempt.delivery_deadline_at,
          sla_status: slaStatus,
          chain_id: attempt.chain_id,
          contract_address: attempt.contract_address,
          onchain_packet_id: attempt.onchain_packet_id!,
          submit_tx_hash: attempt.tx_hash!,
          submit_log_index: attempt.submit_log_index!,
          packet_ct_hash: attempt.action_ct_hash!,
          binary_index_ct_hash: attempt.action_ct_hash!,
          confidence_ct_hash: attempt.signal_ct_hash!,
          created_at: nowIso(this.now()),
        });
        fhenixGatewayFeedPacketTxRepo.markAccepted(this.db, {
          attempt_id: attempt.attempt_id,
          packet_id: packetId,
          updated_at: nowIso(this.now()),
        });
      })();
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = feedPacketsRepo.byFhenixEvent(this.db, {
          chain_id: attempt.chain_id,
          contract_address: attempt.contract_address,
          onchain_packet_id: attempt.onchain_packet_id ?? "",
        });
        if (existing) {
          fhenixGatewayFeedPacketTxRepo.markAccepted(this.db, {
            attempt_id: attempt.attempt_id,
            packet_id: existing.packet_id,
            updated_at: nowIso(this.now()),
          });
          return true;
        }
      }
      fhenixGatewayFeedPacketTxRepo.markTerminalFailure(this.db, {
        attempt_id: attempt.attempt_id,
        last_error: errorMessage(err),
        updated_at: nowIso(this.now()),
      });
      return false;
    }
  }

	  private async confirmationState(receipt: GatewayReceipt): Promise<ConfirmationState> {
	    if (this.confirmations === 0 || receipt.blockNumber === undefined) {
	      return {
	        ready: true,
	        latestBlockNumber: safeBlockNumber(receipt.blockNumber),
	        latestBlockLatencyMs: null,
	        confirmationsObserved: receipt.blockNumber === undefined ? null : 1,
	      };
	    }
	    const latest = await measure(() => this.client.getBlockNumber());
	    const observed = latest.value >= receipt.blockNumber
	      ? latest.value - receipt.blockNumber + 1n
	      : 0n;
	    return {
	      ready: latest.value >= receipt.blockNumber + BigInt(this.confirmations - 1),
	      latestBlockNumber: safeBlockNumber(latest.value),
	      latestBlockLatencyMs: latest.latencyMs,
	      confirmationsObserved: safeBlockNumber(observed),
	    };
	  }

  private extractSubmitEvent(
    attempt: FhenixGatewayTxAttemptRow,
    receipt: GatewayReceipt,
  ): {
    logIndex: number;
    blockNumber: number | null;
    onchain_call_id: string;
    binary_index_ct_hash: string;
    confidence_ct_hash: string;
    accepted_at: string;
    reveal_open_at: string;
  } | null {
    for (const log of receipt.logs) {
      if (!isAddressEqual(getAddress(log.address), getAddress(attempt.contract_address as Address))) {
        continue;
      }
      try {
        const decoded = decodeEventLog({
          abi: [SEALED_CALL_SUBMITTED_EVENT],
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        const args = decoded.args as {
          callId: Hex;
          agent: Address;
          marketId: Hex;
          acceptedAt: bigint;
          revealOpenAt: bigint;
          binaryIndexCtHash: Hex;
          confidenceCtHash: Hex;
          clientNonce: Hex;
        };
        if (decoded.eventName !== "SealedCallSubmitted") continue;
        if (!isAddressEqual(args.agent, attempt.agent_wallet_address as Address)) continue;
        if (args.marketId.toLowerCase() !== attempt.market_id_hash) continue;
        if (args.clientNonce.toLowerCase() !== attempt.client_nonce) continue;
        return {
          logIndex: log.logIndex,
          blockNumber: safeBlockNumber(log.blockNumber ?? receipt.blockNumber),
          onchain_call_id: args.callId.toLowerCase(),
          binary_index_ct_hash: args.binaryIndexCtHash.toLowerCase(),
          confidence_ct_hash: args.confidenceCtHash.toLowerCase(),
          accepted_at: unixSecondsToIso(args.acceptedAt),
          reveal_open_at: unixSecondsToIso(args.revealOpenAt),
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  private extractFeedPacketEvent(
    attempt: FhenixGatewayFeedPacketTxAttemptRow,
    receipt: GatewayReceipt,
  ): {
    logIndex: number;
    blockNumber: number | null;
    onchain_packet_id: string;
    action_ct_hash: string;
    signal_ct_hash: string;
    accepted_at: string;
  } | null {
    for (const log of receipt.logs) {
      if (!isAddressEqual(getAddress(log.address), getAddress(attempt.contract_address as Address))) {
        continue;
      }
      try {
        const decoded = decodeEventLog({
          abi: [FEED_PACKET_SUBMITTED_EVENT],
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        const args = decoded.args as {
          packetId: Hex;
          agent: Address;
          feedId: Hex;
          marketId: Hex;
          acceptedAt: bigint;
          revealAfter: bigint;
          actionCtHash: Hex;
          signalCtHash: Hex;
          clientNonce: Hex;
        };
        if (decoded.eventName !== "FeedPacketSubmitted") continue;
        if (!isAddressEqual(args.agent, attempt.agent_wallet_address as Address)) continue;
        if (args.feedId.toLowerCase() !== attempt.feed_id_hash) continue;
        if (args.marketId.toLowerCase() !== attempt.market_id_hash) continue;
        if (args.clientNonce.toLowerCase() !== attempt.client_nonce) continue;
        const revealAfter = unixSecondsToIso(args.revealAfter);
        if (revealAfter !== attempt.reveal_after) continue;
        return {
          logIndex: log.logIndex,
          blockNumber: safeBlockNumber(log.blockNumber ?? receipt.blockNumber),
          onchain_packet_id: args.packetId.toLowerCase(),
          action_ct_hash: args.actionCtHash.toLowerCase(),
          signal_ct_hash: args.signalCtHash.toLowerCase(),
          accepted_at: unixSecondsToIso(args.acceptedAt),
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  private nextRetryAt(nextAttemptNumber: number): string {
    const delay = Math.min(
      this.retryMaxMs,
      this.retryBaseMs * 2 ** Math.max(0, nextAttemptNumber - 1),
    );
    return isoFromMs(this.now().getTime() + delay);
  }
}

export function createFhenixGatewayFromEnv(
  db: Database.Database,
  verifier: FhenixEventVerifier,
): FhenixGatewayBroadcaster | null {
  const enabled = process.env.FHENIX_GATEWAY_ENABLED === "true";
  const rpcUrl = process.env.FHENIX_RPC_URL?.trim();
  const rawChainId = process.env.FHENIX_CHAIN_ID?.trim();
  const privateKey = process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY?.trim();
  if (!enabled) return null;
  if (!rpcUrl || !rawChainId || !privateKey) {
    throw new Error(
      "FHENIX_GATEWAY_ENABLED=true requires FHENIX_RPC_URL, FHENIX_CHAIN_ID, and FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
    );
  }
  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("FHENIX_CHAIN_ID must be a positive integer");
  }
  const contractAddress = resolveFhenixContractAddress(chainId);
  if (!contractAddress) {
    throw new Error(
      `FHENIX_GATEWAY_ENABLED=true but no contract address found: set FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or run sync-deployments to populate data/deployments.json for chainId ${chainId}`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY must be a 32-byte 0x-prefixed private key");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  });
  const client: FhenixGatewayClient = {
    getChainId: () => publicClient.getChainId(),
    getBlockNumber: () => publicClient.getBlockNumber(),
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args),
    writeContract: (args) =>
      walletClient.writeContract({
        ...args,
        account,
        chain: null,
      } as never),
  };
  return new FhenixGatewayBroadcaster({
    db,
    verifier,
    chainId,
    contractAddress,
    relayerAddress: account.address,
    client,
    confirmations: numberEnv("FHENIX_GATEWAY_CONFIRMATIONS", 2),
    retryBaseMs: numberEnv("FHENIX_GATEWAY_RETRY_BASE_MS", 5_000),
    retryMaxMs: numberEnv("FHENIX_GATEWAY_RETRY_MAX_MS", 120_000),
    maxAttempts: numberEnv("FHENIX_GATEWAY_MAX_ATTEMPTS", 5),
    stuckAfterMs: numberEnv("FHENIX_GATEWAY_STUCK_SEC", 600) * 1_000,
  });
}

function preflightMarketAndRateLimits(
  db: Database.Database,
  agentId: string,
  market: NonNullable<ReturnType<typeof marketsRepo.get>>,
  now: () => Date,
): void {
  if (!acceptsSubmissions(market)) {
    throw new VerdictError(
      `market ${market.market_id} status=${market.status} (not accepting submissions)`,
      ERROR_CODES.asset_not_supported,
      400,
      {
        reason: "market_not_listed",
        market_id: market.market_id,
        market_status: market.status,
      },
    );
  }
  try {
    derivePolicyFromMarket(db, market);
  } catch (err) {
    if (err instanceof PolicyDerivationError) {
      throw new VerdictError(
        `cannot mint call on ${market.market_id}: ${err.message}`,
        ERROR_CODES.asset_not_supported,
        400,
        {
          reason: "policy_derivation_failed",
          market_id: market.market_id,
          cause: err.cause,
        },
      );
    }
    throw err;
  }
  const activeCount =
    agentsRepo.countActiveCallsForAgent(db, agentId) +
    fhenixGatewayTxRepo.countInflightByAgent(db, agentId);
  if (activeCount >= SUBMISSION_LIMITS.max_active_calls_per_agent) {
    throw new VerdictError(
      `max ${SUBMISSION_LIMITS.max_active_calls_per_agent} active calls per agent`,
      ERROR_CODES.rate_limited,
      429,
    );
  }
  const since = isoFromMs(now().getTime() - 24 * 60 * 60 * 1000);
  const cap = perMarketDailyCap(market.market_id);
  const count =
    submissionsRepo.countCallsForAgentMarketWindow(db, agentId, market.market_id, since) +
    fhenixGatewayTxRepo.countInflightByAgentMarketWindow(db, agentId, market.market_id, since);
  if (count >= cap) {
    throw new VerdictError(
      `max ${cap} calls/market/24h on ${market.market_id}`,
      ERROR_CODES.rate_limited,
      429,
      { market_id: market.market_id, cap },
    );
  }
}

function contractInput(input: CofheInput): ContractCofheInput {
  return {
    ctHash: BigInt(input.ct_hash),
    securityZone: input.security_zone,
    utype: input.utype,
    signature: input.signature as Hex,
  };
}

function resultFromAttempt(
  attempt: FhenixGatewayTxAttemptRow,
  idempotent_hit: boolean,
): GatewaySubmitResult {
  return {
    status: attempt.status === "accepted" ? 200 : 202,
    body: {
      attempt_id: attempt.attempt_id,
      status: attempt.status,
      tx_hash: attempt.tx_hash,
      call_id: attempt.call_id,
      next_attempt_at: attempt.next_attempt_at,
      idempotent_hit,
    },
  };
}

function feedResultFromAttempt(
  attempt: FhenixGatewayFeedPacketTxAttemptRow,
  idempotent_hit: boolean,
  db: Database.Database,
): GatewayFeedPacketSubmitResult {
  const packet = attempt.packet_id ? feedPacketsRepo.byFhenixEvent(db, {
    chain_id: attempt.chain_id,
    contract_address: attempt.contract_address,
    onchain_packet_id: attempt.onchain_packet_id ?? "",
  }) : null;
  return {
    status: attempt.status === "accepted" ? 200 : 202,
    body: {
      attempt_id: attempt.attempt_id,
      status: attempt.status,
      tx_hash: attempt.tx_hash,
      packet_id: attempt.packet_id,
      sequence: attempt.sequence,
      sla_status: packet?.sla_status ?? null,
      next_attempt_at: attempt.next_attempt_at,
      idempotent_hit,
    },
  };
}

function operatorAttempt(row: FhenixGatewayTxAttemptRow): GatewayOperatorAttempt {
  return {
    attempt_id: row.attempt_id,
    status: row.status,
    account_id: row.account_id,
    agent_id: row.agent_id,
    runtime_key_id: row.runtime_key_id,
    runtime_key_policy_hash: row.runtime_key_policy_hash,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    relayer_address: row.relayer_address,
    agent_wallet_address: row.agent_wallet_address,
    market_id: row.market_id,
    market_id_hash: row.market_id_hash,
    market_ref_protocol: row.market_ref_protocol,
    market_config_version: row.market_config_version,
    client_order_id: row.client_order_id,
    client_nonce: row.client_nonce,
    tx_hash: row.tx_hash,
    submit_log_index: row.submit_log_index,
    submit_block_number: row.submit_block_number,
    onchain_call_id: row.onchain_call_id,
    call_id: row.call_id,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    broadcast_started_at: row.broadcast_started_at,
    broadcast_latency_ms: row.broadcast_latency_ms,
    receipt_observed_at: row.receipt_observed_at,
    receipt_latency_ms: row.receipt_latency_ms,
    latest_block_latency_ms: row.latest_block_latency_ms,
    receipt_status: row.receipt_status,
    receipt_block_number: row.receipt_block_number,
    latest_block_number: row.latest_block_number,
    confirmations_observed: row.confirmations_observed,
    gas_used: row.gas_used,
    effective_gas_price_wei: row.effective_gas_price_wei,
    last_rpc_error: row.last_rpc_error,
    submitted_at: row.submitted_at,
    accepted_at: row.accepted_at,
    reveal_open_at: row.reveal_open_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function operatorFeedAttempt(
  row: FhenixGatewayFeedPacketTxAttemptRow,
): GatewayOperatorFeedAttempt {
  return {
    attempt_id: row.attempt_id,
    status: row.status,
    account_id: row.account_id,
    agent_id: row.agent_id,
    runtime_key_id: row.runtime_key_id,
    runtime_key_policy_hash: row.runtime_key_policy_hash,
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    relayer_address: row.relayer_address,
    agent_wallet_address: row.agent_wallet_address,
    feed_id: row.feed_id,
    feed_id_hash: row.feed_id_hash,
    market_id: row.market_id,
    market_id_hash: row.market_id_hash,
    packet_kind: row.packet_kind,
    sequence: row.sequence,
    payload_schema: row.payload_schema,
    client_order_id: row.client_order_id,
    client_nonce: row.client_nonce,
    tx_hash: row.tx_hash,
    submit_log_index: row.submit_log_index,
    submit_block_number: row.submit_block_number,
    onchain_packet_id: row.onchain_packet_id,
    packet_id: row.packet_id,
    action_ct_hash: row.action_ct_hash,
    signal_ct_hash: row.signal_ct_hash,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    broadcast_started_at: row.broadcast_started_at,
    broadcast_latency_ms: row.broadcast_latency_ms,
    receipt_observed_at: row.receipt_observed_at,
    receipt_latency_ms: row.receipt_latency_ms,
    latest_block_latency_ms: row.latest_block_latency_ms,
    receipt_status: row.receipt_status,
    receipt_block_number: row.receipt_block_number,
    latest_block_number: row.latest_block_number,
    confirmations_observed: row.confirmations_observed,
    gas_used: row.gas_used,
    effective_gas_price_wei: row.effective_gas_price_wei,
    last_rpc_error: row.last_rpc_error,
    submitted_at: row.submitted_at,
    delivery_deadline_at: row.delivery_deadline_at,
    accepted_at: row.accepted_at,
    reveal_after: row.reveal_after,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function deriveFeedRevealAfter(
  feed: FeedContractRow,
  requested: string | undefined,
  now: Date,
): string {
  if (requested) return stripIsoMillis(requested);
  const policy = parseJsonObject(feed.reveal_policy_json, "feed.reveal_policy_json");
  if (policy.kind === "fixed_delay" && typeof policy.delay_seconds === "number") {
    return isoFromMs(now.getTime() + policy.delay_seconds * 1000);
  }
  const delaySeconds = Math.max(
    60,
    feed.max_latency_seconds ?? feed.delivery_cadence_seconds ?? 3600,
  );
  return isoFromMs(now.getTime() + delaySeconds * 1000);
}

function fhenixFeedIdForMurmurFeed(feedId: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(feedId)) return feedId.toLowerCase();
  return keccak256(toBytes(feedId)).toLowerCase();
}

function parseJsonObject(raw: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${field} is malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stripIsoMillis(value: string): string {
  return new Date(value).toISOString().replace(/\.\d+Z$/, "Z");
}

async function measure<T>(fn: () => Promise<T>): Promise<Measured<T>> {
  const started = Date.now();
  const value = await fn();
  return {
    value,
    latencyMs: Math.max(0, Date.now() - started),
  };
}

function receiptTelemetry(input: {
  attempt_id: string;
  receipt: GatewayReceipt;
  receipt_observed_at: string;
  receipt_latency_ms: number;
  confirmation: ConfirmationState | null;
  last_rpc_error: string | null;
}): FhenixGatewayReceiptTelemetry {
  return {
    attempt_id: input.attempt_id,
    receipt_observed_at: input.receipt_observed_at,
    receipt_latency_ms: input.receipt_latency_ms,
    latest_block_latency_ms: input.confirmation?.latestBlockLatencyMs ?? null,
    receipt_status: input.receipt.status ?? null,
    receipt_block_number: safeBlockNumber(input.receipt.blockNumber),
    latest_block_number: input.confirmation?.latestBlockNumber ?? null,
    confirmations_observed: input.confirmation?.confirmationsObserved ?? null,
    gas_used: input.receipt.gasUsed?.toString() ?? null,
    effective_gas_price_wei: input.receipt.effectiveGasPrice?.toString() ?? null,
    last_rpc_error: input.last_rpc_error,
  };
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function normalizeAddress(value: string): string {
  return getAddress(value as Address).toLowerCase();
}

function unixSecondsToIso(value: bigint): string {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(`unsafe Fhenix event timestamp: ${value.toString()}`);
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function safeBlockNumber(value: bigint | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
