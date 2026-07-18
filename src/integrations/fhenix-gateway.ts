import type Database from "better-sqlite3";
import {
  broadcastGatewayAttempt,
  confirmGatewayAttempt,
  type GatewayAttemptKind,
} from "./fhenix-gateway-attempt-machine.js";
import {
  feedPacketAttemptKind,
  sealedCallAttemptKind,
} from "./fhenix-gateway-attempt-kinds.js";
import { loadFhenixGatewayEnvConfig } from "./fhenix-gateway-env.js";
import type { FhenixGatewayClient } from "./fhenix-gateway-contract.js";
import type { MurmurOwnedCofheSealer } from "./murmur-owned-cofhe-sealer.js";
import {
  MurmurOwnedSealedCallBodySchema,
  murmurOwnedSealedCallToGatewayBody,
} from "./murmur-owned-sealing-schemas.js";
import {
  GatewayFeedPacketBodySchema,
  GatewaySealedCallBodySchema,
} from "./fhenix-gateway-schemas.js";
import {
  buildGatewayOperatorSnapshot,
  gatewayFeedPacketResult as feedResultFromAttempt,
  gatewaySubmissionResult as resultFromAttempt,
  type GatewayFeedPacketSubmitResult,
  type GatewayOperatorSnapshot,
  type GatewaySubmitResult,
} from "./fhenix-gateway-presenters.js";
import {
  reserveFeedPacketAttempt,
  reserveSealedCallAttempt,
} from "./fhenix-gateway-reservations.js";
import {
  normalizeAddress,
  type FhenixGatewayRuntimeTimers,
} from "./fhenix-gateway-runtime.js";
import { fhenixGatewayTxRepo } from "../verdict/repos/fhenix-gateway-tx-repo.js";
import { fhenixGatewayFeedPacketTxRepo } from "../verdict/repos/fhenix-gateway-feed-packet-tx-repo.js";
import {
  isBroadcastableStatus,
  type FhenixGatewayTxStatus,
  type GatewayAttemptLifecycleRow,
} from "../verdict/repos/fhenix-gateway-attempt-lifecycle.js";
import {
  type AgentSecurityEventIdAdapter,
  makeAgentSecurityEvent,
} from "../verdict/agent-security-event.js";
import { agentSecurityEventsRepo } from "../verdict/repos/agent-security-events-repo.js";
import { agentsRepo } from "../verdict/repos/agents-repo.js";
import { feedContractsRepo } from "../verdict/repos/feed-availability-repo.js";
import type { FeedPacketIdAdapter } from "../verdict/feed-packet-ingestion.js";
import type { SealedCallIdAdapter } from "../verdict/sealed-call-acceptance.js";
import { marketsRepo } from "../verdict/repos/market-registry-repo.js";
import { submissionsRepo } from "../verdict/repos/sealed-call-submissions-repo.js";
import {
  ERROR_CODES,
  VerdictError,
} from "../verdict/schema.js";
import { isoFromMs, nowIso } from "../verdict/time.js";
import type { AuthIdentity } from "../verdict/auth/dispatcher.js";
import {
  requireRuntimeKeyIdentity,
} from "../verdict/auth/runtime-authorization.js";

export {
  MURMUR_SEALED_VERDICTS_GATEWAY_ABI,
} from "./fhenix-gateway-contract.js";
export type {
  FhenixGatewayClient,
  GatewayLog,
  GatewayReceipt,
  GatewayWriteContractArgs,
} from "./fhenix-gateway-contract.js";
export {
  CofheInputSchema,
  GatewayFeedPacketBodySchema,
  GatewaySealedCallBodySchema,
} from "./fhenix-gateway-schemas.js";
export type {
  CofheInput,
  GatewayFeedPacketBody,
  GatewaySealedCallBody,
} from "./fhenix-gateway-schemas.js";
export type {
  GatewayFeedPacketSubmitResult,
  GatewayOperatorAttempt,
  GatewayOperatorFeedAttempt,
  GatewayOperatorSnapshot,
  GatewaySubmitResult,
} from "./fhenix-gateway-presenters.js";

export interface FhenixGatewayConfig {
  db: Database.Database;
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  client: FhenixGatewayClient;
  murmurOwnedSealer?: MurmurOwnedCofheSealer | null;
  confirmations?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  stuckAfterMs?: number;
  /**
   * Hard deadline for a single writeContract round-trip. The contract
   * dedups by client_nonce, so a timeout that fires while a tx actually
   * lands on-chain only costs wasted gas on the next retry (the second
   * broadcast will revert). The default sits well below stuckAfterMs
   * so a hung broadcast surfaces as a retryable failure long before
   * sweepStuckClaims kicks in. 0 disables.
  */
  broadcastTimeoutMs?: number;
  /**
   * Block height the reconciliation log scan starts from when a previous
   * writeContract timed out and we need to recover the on-chain tx_hash
   * via getLogs. Defaults to 0 — the env-config layer in
   * fhenix-gateway-env.ts:loadFhenixGatewayEnvConfig() prefers the
   * manifest deployment block when available.
   */
  reconcileFromBlock?: number;
  timers?: FhenixGatewayRuntimeTimers;
  newAttemptId?: () => string;
  newClaimToken?: () => string;
  newFeedPacketId?: FeedPacketIdAdapter;
  newSealedCallId?: SealedCallIdAdapter;
  /**
   * Adapter for `admin_fhenix_gateway_retry` audit event ids. Defaults to
   * randomUUID inside makeAgentSecurityEvent.
   */
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: () => Date;
}

export interface GatewayTickResult {
  broadcasted: number;
  confirmed: number;
  accepted: number;
  failed: number;
}

export class FhenixGatewayBroadcaster {
  private readonly db: Database.Database;
  private readonly chainId: number;
  private readonly contractAddress: string;
  private readonly relayerAddress: string;
  private readonly client: FhenixGatewayClient;
  private readonly murmurOwnedSealer: MurmurOwnedCofheSealer | null;
  private readonly confirmations: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly broadcastTimeoutMs: number;
  private readonly reconcileFromBlock: number;
  private readonly stuckAfterMs: number;
  private readonly timers: FhenixGatewayRuntimeTimers | undefined;
  private readonly newAttemptId: (() => string) | undefined;
  private readonly newClaimToken: (() => string) | undefined;
  private readonly newFeedPacketId: FeedPacketIdAdapter | undefined;
  private readonly newSealedCallId: SealedCallIdAdapter | undefined;
  private readonly newAgentSecurityEventId: AgentSecurityEventIdAdapter | undefined;
  private readonly now: () => Date;
  private readonly sealedKind: ReturnType<typeof sealedCallAttemptKind>;
  private readonly feedKind: ReturnType<typeof feedPacketAttemptKind>;

  constructor(config: FhenixGatewayConfig) {
    this.db = config.db;
    this.chainId = config.chainId;
    this.contractAddress = normalizeAddress(config.contractAddress);
    this.relayerAddress = normalizeAddress(config.relayerAddress);
    this.client = config.client;
    this.murmurOwnedSealer = config.murmurOwnedSealer ?? null;
    this.confirmations = Math.max(0, Math.floor(config.confirmations ?? 2));
    this.retryBaseMs = Math.max(1_000, Math.floor(config.retryBaseMs ?? 5_000));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(config.retryMaxMs ?? 120_000));
    this.maxAttempts = Math.max(1, Math.floor(config.maxAttempts ?? 5));
    this.stuckAfterMs = Math.max(60_000, Math.floor(config.stuckAfterMs ?? 10 * 60_000));
    // 0 = disabled; otherwise clamp to at least 1s so a misconfiguration
    // doesn't silently broadcast and immediately time out.
    this.broadcastTimeoutMs = config.broadcastTimeoutMs === 0
      ? 0
      : Math.max(1_000, Math.floor(config.broadcastTimeoutMs ?? 90_000));
    this.reconcileFromBlock = Math.max(0, Math.floor(config.reconcileFromBlock ?? 0));
    this.timers = config.timers;
    this.newAttemptId = config.newAttemptId;
    this.newClaimToken = config.newClaimToken;
    this.newFeedPacketId = config.newFeedPacketId;
    this.newSealedCallId = config.newSealedCallId;
    this.newAgentSecurityEventId = config.newAgentSecurityEventId;
    this.now = config.now;
    this.sealedKind = sealedCallAttemptKind({
      newSealedCallId: this.newSealedCallId,
    });
    this.feedKind = feedPacketAttemptKind({
      newFeedPacketId: this.newFeedPacketId,
    });
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
    const { agent_id: agentId } = runtimeIdentity;

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
    const reservation = reserveSealedCallAttempt({
      db: this.db,
      runtimeIdentity,
      body,
      market,
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      relayerAddress: this.relayerAddress,
      newAttemptId: this.newAttemptId,
      now: this.now,
    });
    if (reservation.kind === "existing_attempt") {
      return resultFromAttempt(reservation.attempt, true);
    }
    if (reservation.kind === "accepted_submission") {
      return {
        status: 200,
        body: {
          attempt_id: "",
          status: "accepted",
          tx_hash: null,
          call_id: reservation.call_id,
          next_attempt_at: nowIso(this.now()),
          idempotent_hit: true,
        },
      };
    }

    await this.broadcastAttempt(reservation.attempt_id);
    const row = fhenixGatewayTxRepo.byId(this.db, reservation.attempt_id);
    if (!row) throw new Error(`gateway attempt missing after insert: ${reservation.attempt_id}`);
    return resultFromAttempt(row, false);
  }

  async submitMurmurSealedCall(params: {
    authResult: AuthIdentity;
    bodyJson: unknown;
  }): Promise<GatewaySubmitResult> {
    if (!this.murmurOwnedSealer) {
      throw new VerdictError(
        "Murmur-owned sealing is not configured; set MURMUR_OWNED_SEALING_ENABLED=true with CoFHE signer credentials",
        ERROR_CODES.oracle_unavailable,
        503,
      );
    }
    const parsed = MurmurOwnedSealedCallBodySchema.safeParse(params.bodyJson);
    if (!parsed.success) {
      throw new VerdictError(
        "murmur-owned sealed call failed schema validation",
        ERROR_CODES.schema_invalid,
        400,
        { issues: parsed.error.format() },
      );
    }
    const runtimeIdentity = requireRuntimeKeyIdentity(
      params.authResult,
      "murmur-owned sealing requires X-Murmur-Runtime-Key auth",
    );
    const existingAttempt = fhenixGatewayTxRepo.byClientOrder(
      this.db,
      runtimeIdentity.agent_id,
      parsed.data.client_order_id,
    );
    if (existingAttempt) {
      return resultFromAttempt(existingAttempt, true);
    }
    const existingSubmission = submissionsRepo.findByClientOrderId(
      this.db,
      runtimeIdentity.agent_id,
      parsed.data.client_order_id,
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

    const sealed = await this.murmurOwnedSealer.sealVerdict(parsed.data.verdict);
    return this.submitSealedCall({
      authResult: params.authResult,
      bodyJson: murmurOwnedSealedCallToGatewayBody({
        body: parsed.data,
        binaryIndexInput: sealed.binary_index_input,
        confidenceInput: sealed.confidence_input,
      }),
    });
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
    const { agent_id: agentId } = runtimeIdentity;

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
    const reservation = reserveFeedPacketAttempt({
      db: this.db,
      runtimeIdentity,
      body,
      feed,
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      relayerAddress: this.relayerAddress,
      newAttemptId: this.newAttemptId,
      now: this.now,
    });
    if (reservation.kind === "existing_attempt") {
      return feedResultFromAttempt(reservation.attempt, true, this.db);
    }

    await this.broadcastFeedPacketAttempt(reservation.attempt_id);
    const row = fhenixGatewayFeedPacketTxRepo.byId(this.db, reservation.attempt_id);
    if (!row) throw new Error(`gateway feed attempt missing after insert: ${reservation.attempt_id}`);
    return feedResultFromAttempt(row, false, this.db);
  }

  async tick(): Promise<GatewayTickResult> {
    const counters: GatewayTickResult = {
      broadcasted: 0,
      confirmed: 0,
      accepted: 0,
      failed: 0,
    };
    // Release any claims held by crashed/killed broadcast processes BEFORE
    // listing due attempts. Without this, an attempt whose claimant died
    // mid-broadcast would stay claimed forever and never re-broadcast.
    const stuckBeforeIso = isoFromMs(this.now().getTime() - this.stuckAfterMs);
    const sweepUpdatedAt = nowIso(this.now());
    this.sealedKind.lifecycle.sweepStuckClaims(this.db, {
      stuckBeforeIso,
      updated_at: sweepUpdatedAt,
      errorMessage: "broadcast claim stuck; reset by tick sweep",
    });
    this.feedKind.lifecycle.sweepStuckClaims(this.db, {
      stuckBeforeIso,
      updated_at: sweepUpdatedAt,
      errorMessage: "broadcast claim stuck; reset by tick sweep",
    });
    await this.tickKind(this.sealedKind, counters);
    await this.tickKind(this.feedKind, counters);
    return counters;
  }

  private async tickKind<Row extends GatewayAttemptLifecycleRow, Event>(
    kind: GatewayAttemptKind<Row, Event>,
    counters: GatewayTickResult,
  ): Promise<void> {
    for (const attempt of kind.lifecycle.listDueForBroadcast(
      this.db,
      nowIso(this.now()),
    )) {
      const result = await broadcastGatewayAttempt(kind, {
        ...this.broadcastConfig(),
        attemptId: attempt.attempt_id,
      });
      // The machine reports the transition it performed; a fresh on-chain
      // write ("submitted") counts as a broadcast, a "reconciled" recovery
      // does not (no new write landed). Terminal outcomes count as failures.
      if (result.kind === "submitted") counters.broadcasted++;
      if (result.kind === "terminal_failure") counters.failed++;
    }
    for (const attempt of kind.lifecycle.listSubmittedForConfirmation(this.db)) {
      const confirmed = await confirmGatewayAttempt(kind, {
        db: this.db,
        client: this.client,
        confirmations: this.confirmations,
        attempt,
        now: this.now,
      });
      if (confirmed.kind !== "confirmed") continue;
      const ok = confirmed.attempt
        ? await kind.accept(this.db, confirmed.attempt, this.now)
        : true;
      if (ok) {
        counters.confirmed++;
        const after = kind.lifecycle.byId(this.db, attempt.attempt_id);
        if (after?.status === "accepted") counters.accepted++;
      }
    }
    for (const attempt of kind.lifecycle.listConfirmedForAcceptance(this.db)) {
      const ok = await kind.accept(this.db, attempt, this.now);
      if (ok) counters.accepted++;
      else counters.failed++;
    }
  }

  operatorSnapshot(opts: {
    servedAt: Date;
    status?: FhenixGatewayTxStatus;
    limit?: number;
    stuckAfterMs?: number;
  }): GatewayOperatorSnapshot {
    return buildGatewayOperatorSnapshot({
      db: this.db,
      servedAt: opts.servedAt,
      status: opts.status,
      limit: opts.limit,
      stuckAfterMs: opts.stuckAfterMs,
      config: {
        chain_id: this.chainId,
        contract_address: this.contractAddress,
        relayer_address: this.relayerAddress,
        confirmations: this.confirmations,
        retry_base_ms: this.retryBaseMs,
        retry_max_ms: this.retryMaxMs,
        max_attempts: this.maxAttempts,
        stuck_after_ms: this.stuckAfterMs,
      },
    });
  }

  async retryAttemptNow(
    attemptId: string,
  ): Promise<GatewaySubmitResult | GatewayFeedPacketSubmitResult> {
    const sealed = await this.retryKind(this.sealedKind, attemptId);
    if (sealed) return sealed;
    const feed = await this.retryKind(this.feedKind, attemptId);
    if (feed) return feed;
    throw new VerdictError(
      `unknown Fhenix Gateway attempt: ${attemptId}`,
      ERROR_CODES.asset_not_supported,
      404,
    );
  }

  private async retryKind<Row extends GatewayAttemptLifecycleRow, Event>(
    kind: GatewayAttemptKind<Row, Event>,
    attemptId: string,
  ): Promise<GatewaySubmitResult | GatewayFeedPacketSubmitResult | null> {
    const attempt = kind.lifecycle.byId(this.db, attemptId);
    if (!attempt) return null;
    if (!isBroadcastableStatus(attempt.status)) {
      throw new VerdictError(
        kind.retryConflictMessage(attempt.status),
        ERROR_CODES.schema_invalid,
        409,
        {
          attempt_id: attempt.attempt_id,
          status: attempt.status,
        },
      );
    }
    // Fix 3 — emit `admin_fhenix_gateway_retry` audit in the same
    // transaction as the queue-state mutation so the forensic record
    // and the state change commit together. Resolve agent_id from the
    // attempt's wallet so listForAgent surfaces the retry in the agent's
    // own security timeline (codex audit finding).
    // agents.chain_id is CAIP-2 (schema.ts ChainIdSchema), so the lookup
    // must use the eip155 form — a bare numeric string never matches.
    const agent = agentsRepo.byWallet(
      this.db,
      attempt.agent_wallet_address,
      `eip155:${this.chainId}`,
    );
    this.db.transaction(() => {
      kind.lifecycle.markRetryNow(this.db, {
        attempt_id: attempt.attempt_id,
        next_attempt_at: nowIso(this.now()),
        updated_at: nowIso(this.now()),
      });
      agentSecurityEventsRepo.emit(
        this.db,
        makeAgentSecurityEvent({
          kind: "admin_fhenix_gateway_retry",
          actor: "admin_token",
          agent_id: agent?.agent_id ?? null,
          newEventId: this.newAgentSecurityEventId,
          payload: kind.retryAuditPayload(attempt, {
            chain_id: this.chainId,
            contract_address: this.contractAddress,
          }),
          createdAt: this.now(),
        }),
      );
    })();
    await broadcastGatewayAttempt(kind, {
      ...this.broadcastConfig(),
      attemptId: attempt.attempt_id,
    });
    const row = kind.lifecycle.byId(this.db, attempt.attempt_id);
    if (!row) {
      throw new Error(kind.missingAfterRetryMessage(attempt.attempt_id));
    }
    return kind.presentResult(this.db, row, false);
  }

  private async broadcastAttempt(attemptId: string): Promise<void> {
    await broadcastGatewayAttempt(this.sealedKind, {
      ...this.broadcastConfig(),
      attemptId,
    });
  }

  private async broadcastFeedPacketAttempt(attemptId: string): Promise<void> {
    await broadcastGatewayAttempt(this.feedKind, {
      ...this.broadcastConfig(),
      attemptId,
    });
  }

  private broadcastConfig() {
    return {
      db: this.db,
      client: this.client,
      chainId: this.chainId,
      contractAddress: this.contractAddress,
      reconcileFromBlock: this.reconcileFromBlock,
      maxAttempts: this.maxAttempts,
      retryBaseMs: this.retryBaseMs,
      retryMaxMs: this.retryMaxMs,
      broadcastTimeoutMs: this.broadcastTimeoutMs,
      timers: this.timers,
      newClaimToken: this.newClaimToken,
      now: this.now,
    };
  }
}

export function createFhenixGatewayFromEnv(
  db: Database.Database,
  opts: {
    env?: NodeJS.ProcessEnv;
    timers?: FhenixGatewayRuntimeTimers;
    newAttemptId?: () => string;
    newClaimToken?: () => string;
    newFeedPacketId?: FeedPacketIdAdapter;
    newSealedCallId?: SealedCallIdAdapter;
    now: () => Date;
  },
): FhenixGatewayBroadcaster | null {
  const config = loadFhenixGatewayEnvConfig(opts.env);
  if (!config) return null;
  return new FhenixGatewayBroadcaster({
    db,
    ...config,
    timers: opts.timers,
    newAttemptId: opts.newAttemptId,
    newClaimToken: opts.newClaimToken,
    newFeedPacketId: opts.newFeedPacketId,
    newSealedCallId: opts.newSealedCallId,
    now: opts.now,
  });
}
