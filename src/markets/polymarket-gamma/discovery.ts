/**
 * Polymarket 5-minute market auto-discovery.
 *
 * Finds imminent crypto "Up or Down" windows via the Gamma date-window
 * listing and registers each one in BOTH places an agent submission needs:
 * the `markets` DB row (staged as `draft`) and the on-chain
 * `registerFixedRevealMarket` entry whose reveal timestamp the sealed-call
 * acceptance guard pins to the market endDate. The DB row is promoted to
 * `listed` only after the chain state is verified, so agents can never see
 * a market the contract would reject.
 *
 * Dedupe is on-chain-aware: every candidate's `markets(bytes32)` tuple is
 * read and compared against the exact fixed-reveal shape before any write —
 * a DB row alone is never proof of registration. The durable
 * `polymarket_discovery_state` ledger carries intent, tx hashes, errors,
 * and gas telemetry across crashes so lost receipts reconcile from chain
 * state instead of re-spending gas.
 */

import type Database from "better-sqlite3";
import type { Hex } from "viem";

import {
  hasExactFixedRevealState,
  isRegisteredOnchain,
  type FhenixMarketRegistrar,
} from "../../integrations/fhenix-market-registration.js";
import type { AgentSecurityEventIdAdapter } from "../../verdict/agent-security-event.js";
import { endDateMsForMarketConfig } from "../../verdict/market-adapter-config.js";
import {
  runPolymarketMarketRegistration,
  type PolymarketMarketRegistrationGammaAdapter,
} from "../../verdict/polymarket-market-registration.js";
import {
  marketsRepo,
  type MarketRow,
} from "../../verdict/repos/market-registry-repo.js";
import {
  polymarketDiscoveryRepo,
  type PolymarketDiscoveryStateRow,
} from "../../verdict/repos/polymarket-discovery-repo.js";
import { isoFromMs, nowIso } from "../../verdict/time.js";
import type { FetchWindowInput, FetchWindowResult } from "./client.js";
import { parseOutcomeLabels, type GammaMarketSnapshot } from "./transform.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const CONDITION_ID_REGEX = /^0x[0-9a-f]{64}$/;
const MAX_BROADCAST_ATTEMPTS = 5;
const LEDGER_SCAN_LIMIT = 200;
// How long a persisted broadcast hash with no receipt is treated as
// still-pending before a replacement write is allowed. Rebroadcasts carry
// identical calldata, so the worst case of a late-landing original is a
// duplicate no-op registration, not divergent chain state.
const BROADCAST_PENDING_GRACE_MS = 90_000;

// ─── Configuration ──────────────────────────────────────────────────────────

export interface PolymarketDiscoveryEngineConfig {
  /** Expected chain (Base Sepolia = 84532); preflight refuses any other. */
  chainId: number;
  tickSec: number;
  lookaheadMin: number;
  /** Minimum seconds between "now" and a window's endDate to bother. */
  minLeadSec: number;
  questionFilter: string;
  /** Bounded asset names matched as whole words against the question. */
  assets: string[];
  /** Exact required endDate−startDate; 300 = the 5-minute series only. */
  windowDurationSec: number;
  maxPerTick: number;
  maxPerHour: number;
  maxPerDay: number;
  minBalanceWei: bigint;
  warnBalanceWei: bigint;
  maxRegisterCostWei: bigint;
}

export interface PolymarketDiscoveryGammaSource {
  fetchMarketsClosingBetween(
    input: FetchWindowInput,
  ): Promise<FetchWindowResult>;
  fetchMarketByConditionId(
    conditionId: string,
  ): Promise<{ snapshot: GammaMarketSnapshot | null; error: string | null }>;
}

export interface PolymarketDiscoveryEngineDeps {
  db: Database.Database;
  registrar: FhenixMarketRegistrar;
  gamma: PolymarketDiscoveryGammaSource;
  config: PolymarketDiscoveryEngineConfig;
  now: () => Date;
  logger?: Pick<Console, "log" | "warn">;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
}

export interface PolymarketDiscoveryTickResult {
  registered: number;
  promoted: number;
  frozen: number;
  skipped: number;
  error: string | null;
}

// ─── Candidate selection (pure) ─────────────────────────────────────────────

export interface DiscoveryCandidate {
  conditionId: string;
  question: string | null;
  slug: string | null;
  endDateEpochSec: number;
  /** Present for freshly fetched windows; null for ledger-recovered rows. */
  snapshot: GammaMarketSnapshot | null;
}

export interface DiscoveryCandidateFilter {
  nowMs: number;
  minLeadSec: number;
  questionFilter: string;
  assets: string[];
  windowDurationSec: number;
}

/**
 * Filter raw Gamma window rows down to registrable candidates, earliest
 * end first. Every rejection here is free; everything past this point can
 * cost gas, so the filter is strict and fail-closed on missing fields.
 */
export function selectDiscoveryCandidates(
  snapshots: readonly GammaMarketSnapshot[],
  filter: DiscoveryCandidateFilter,
): DiscoveryCandidate[] {
  const assetPatterns = filter.assets.map(
    (asset) =>
      // Word-bounded match: blocks substring hits inside larger tokens
      // ("Bitcoin" cannot match "Bitcoincash"), but a configured name still
      // matches as the leading word of a longer name ("Ethereum" matches
      // "Ethereum Classic") — configure exact asset names.
      new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(asset)}([^A-Za-z0-9]|$)`, "i"),
  );
  const filterLower = filter.questionFilter.toLowerCase();
  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];
  for (const snapshot of snapshots) {
    const conditionId = snapshot.conditionId.toLowerCase();
    if (!CONDITION_ID_REGEX.test(conditionId)) continue;
    if (seen.has(conditionId)) continue;
    if (snapshot.active !== true) continue;
    if (snapshot.closed === true) continue;
    if (snapshot.archived === true) continue;
    const question = snapshot.question;
    if (typeof question !== "string" || question.length === 0) continue;
    if (!question.toLowerCase().includes(filterLower)) continue;
    if (!assetPatterns.some((pattern) => pattern.test(question))) continue;
    const labels = parseOutcomeLabels(snapshot.outcomes);
    if (
      labels === null ||
      labels.length !== 2 ||
      labels[0].toLowerCase() !== "up" ||
      labels[1].toLowerCase() !== "down"
    ) {
      continue;
    }
    // Exact-duration gate: the Gamma window mixes 5-minute and 15-minute
    // series under the same question shape. Gamma's `startDate` is the market
    // *creation* time (~24h before close), NOT the prediction window start, so
    // endDate−startDate cannot separate the series. The window length lives
    // only in the question text ("7:15PM-7:20PM ET"). Rows whose question shape
    // is unrecognized are rejected, not guessed.
    const windowSec = parseQuestionWindowDurationSec(question);
    if (windowSec === null || windowSec !== filter.windowDurationSec) continue;
    if (typeof snapshot.endDate !== "string") continue;
    const endMs = Date.parse(snapshot.endDate);
    if (!Number.isFinite(endMs)) continue;
    // The chain registers whole seconds while acceptance compares the
    // persisted millisecond timestamp — sub-second endDates cannot satisfy
    // both, so refuse them here.
    if (endMs % 1000 !== 0) continue;
    if (endMs - filter.nowMs < filter.minLeadSec * 1000) continue;
    seen.add(conditionId);
    candidates.push({
      conditionId,
      question,
      slug: typeof snapshot.slug === "string" ? snapshot.slug : null,
      endDateEpochSec: Math.floor(endMs / 1000),
      snapshot,
    });
  }
  candidates.sort((a, b) => a.endDateEpochSec - b.endDateEpochSec);
  return candidates;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const QUESTION_WINDOW_REGEX =
  /(\d{1,2}):(\d{2})\s*([AP]M)\s*-\s*(\d{1,2}):(\d{2})\s*([AP]M)/i;

/**
 * Derive a Polymarket "Up or Down" window's length (seconds) from the clock
 * range in its question ("7:15PM-7:20PM ET" → 300). Returns null when the
 * shape is unrecognized so the caller fails closed. Handles the midnight
 * rollover ("11:55PM-12:00AM" → 300).
 */
export function parseQuestionWindowDurationSec(question: string): number | null {
  const match = question.match(QUESTION_WINDOW_REGEX);
  if (!match) return null;
  const toMinutes = (h: string, m: string, meridiem: string): number | null => {
    let hour = Number(h);
    const minute = Number(m);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (hour === 12) hour = 0;
    return (meridiem.toUpperCase() === "PM" ? hour + 12 : hour) * 60 + minute;
  };
  const start = toMinutes(match[1], match[2], match[3]);
  const end = toMinutes(match[4], match[5], match[6]);
  if (start === null || end === null) return null;
  let diffMin = end - start;
  if (diffMin < 0) diffMin += 24 * 60; // window crosses midnight
  if (diffMin <= 0) return null;
  return diffMin * 60;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

type CandidateOutcome =
  | "registered"
  | "promoted"
  | "frozen"
  | "skipped"
  | "abort";

/** Mutable per-tick relayer balance, decremented per estimated write cost. */
interface TickSpendState {
  balanceWei: bigint | null;
}

export class PolymarketDiscoveryEngine {
  private readonly db: Database.Database;
  private readonly registrar: FhenixMarketRegistrar;
  private readonly gamma: PolymarketDiscoveryGammaSource;
  private readonly config: PolymarketDiscoveryEngineConfig;
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  private preflightOk = false;

  constructor(deps: PolymarketDiscoveryEngineDeps) {
    this.db = deps.db;
    this.registrar = deps.registrar;
    this.gamma = deps.gamma;
    this.config = deps.config;
    this.now = deps.now;
    this.logger = deps.logger ?? console;
    this.newAgentSecurityEventId = deps.newAgentSecurityEventId;
  }

  async tick(): Promise<PolymarketDiscoveryTickResult> {
    const tickedAt = this.now();
    const tickedAtMs = tickedAt.getTime();
    const result: PolymarketDiscoveryTickResult = {
      registered: 0,
      promoted: 0,
      frozen: 0,
      skipped: 0,
      error: null,
    };
    let balanceWei: bigint | null = null;
    let balanceStatus: "ok" | "warning" | "critical" | null = null;
    try {
      // Pure-DB sweep first: ended `listed` markets are guaranteed to reject
      // submissions, so they must freeze even when the RPC is down and every
      // chain-dependent step below throws.
      result.frozen += this.freezeExpired(tickedAtMs);

      await this.ensurePreflight();
      balanceWei = await this.registrar.getRelayerBalanceWei();
      balanceStatus =
        balanceWei < this.config.minBalanceWei
          ? "critical"
          : balanceWei < this.config.warnBalanceWei
            ? "warning"
            : "ok";

      const window = await this.gamma.fetchMarketsClosingBetween({
        endDateMinIso: isoFromMs(tickedAtMs + this.config.minLeadSec * 1000),
        endDateMaxIso: isoFromMs(tickedAtMs + this.config.lookaheadMin * 60_000),
      });
      if (window.error) {
        result.error = `gamma_window:${window.error}`;
      }
      const fresh = selectDiscoveryCandidates(window.snapshots, {
        nowMs: tickedAtMs,
        minLeadSec: this.config.minLeadSec,
        questionFilter: this.config.questionFilter,
        assets: this.config.assets,
        windowDurationSec: this.config.windowDurationSec,
      });
      const candidates = this.mergeLedgerCandidates(fresh, tickedAtMs);

      // Spend caps: per-tick, plus persisted per-hour/per-day counters so a
      // crash-loop or broken filter cannot spend continuously.
      const budget = Math.max(
        0,
        Math.min(
          this.config.maxPerTick,
          this.config.maxPerHour -
            polymarketDiscoveryRepo.countRegisteredSince(
              this.db,
              isoFromMs(tickedAtMs - 60 * 60 * 1000),
            ),
          this.config.maxPerDay -
            polymarketDiscoveryRepo.countRegisteredSince(
              this.db,
              isoFromMs(tickedAtMs - 24 * 60 * 60 * 1000),
            ),
        ),
      );

      // Shared per-tick spend state: each broadcast decrements the balance
      // by its estimated cost so later candidates in the same tick check the
      // reserve against what is actually left, not the tick-start reading.
      const spend: TickSpendState = { balanceWei };
      for (const candidate of candidates) {
        const allowChainWrite =
          balanceStatus !== "critical" && result.registered < budget;
        const outcome = await this.processCandidate(candidate, {
          nowMs: this.now().getTime(),
          allowChainWrite,
          spend,
        });
        switch (outcome) {
          case "registered":
            result.registered += 1;
            break;
          case "promoted":
            result.promoted += 1;
            break;
          case "frozen":
            result.frozen += 1;
            break;
          case "skipped":
            result.skipped += 1;
            break;
          case "abort":
            result.error ??= "tick_aborted";
            break;
        }
        if (outcome === "abort") break;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    polymarketDiscoveryRepo.recordHealth(this.db, {
      enabled: 1,
      tick_interval_sec: this.config.tickSec,
      last_tick_at: nowIso(tickedAt),
      last_success_at: result.error === null ? nowIso(tickedAt) : null,
      last_error: result.error,
      relayer_balance_wei: balanceWei === null ? null : balanceWei.toString(),
      balance_status: balanceStatus,
    });
    return result;
  }

  // ─── Preflight ────────────────────────────────────────────────────────────

  /**
   * One-time (per success) environment check before any owner-key write:
   * the RPC must answer for the configured chain, the contract must have
   * code, and the contract owner must be the relayer account this daemon
   * signs with. Failure keeps every subsequent tick read-only.
   */
  private async ensurePreflight(): Promise<void> {
    if (this.preflightOk) return;
    const chainId = await this.registrar.getChainId();
    if (chainId !== this.config.chainId) {
      throw new Error(
        `preflight:chain_mismatch rpc=${chainId} expected=${this.config.chainId}`,
      );
    }
    if (!(await this.registrar.hasContractCode())) {
      throw new Error(
        `preflight:no_contract_code at ${this.registrar.contractAddress}`,
      );
    }
    const owner = await this.registrar.getOwner();
    if (owner.toLowerCase() !== this.registrar.relayerAddress.toLowerCase()) {
      throw new Error(
        `preflight:owner_mismatch owner=${owner} relayer=${this.registrar.relayerAddress}`,
      );
    }
    this.preflightOk = true;
  }

  // ─── Expiry sweep ─────────────────────────────────────────────────────────

  /**
   * Freeze at endDate, not later: an ended `listed` market is guaranteed to
   * reject submissions, and frozen markets keep resolving existing calls.
   * Covers both ledger rows and manually registered polymarket rows the
   * ledger has never seen. No on-chain deactivation is needed.
   */
  private freezeExpired(nowMs: number): number {
    const now_iso = isoFromMs(nowMs);
    let frozen = 0;
    const endedLedger = [
      ...polymarketDiscoveryRepo.listUnsettled(this.db, LEDGER_SCAN_LIMIT),
      ...polymarketDiscoveryRepo.listByStatus(this.db, "listed", LEDGER_SCAN_LIMIT),
    ].filter((row) => row.end_date_epoch_s * 1000 <= nowMs);
    for (const row of endedLedger) {
      this.db.transaction(() => {
        polymarketDiscoveryRepo.markFrozen(this.db, {
          condition_id: row.condition_id,
          reason: "window_ended",
          now_iso,
        });
        const market = marketsRepo.get(this.db, row.condition_id);
        if (market && (market.status === "listed" || market.status === "draft")) {
          marketsRepo.setStatus(this.db, row.condition_id, "frozen");
        }
      })();
      frozen += 1;
    }
    const listedPolymarket = (
      this.db
        .prepare(
          `SELECT market_id, config_json FROM markets
            WHERE adapter_id = 'polymarket-gamma' AND status = 'listed'`,
        )
        .all() as Array<{ market_id: string; config_json: string }>
    ).filter((row) => {
      const endDateMs = endDateMsForMarketConfig(row.config_json);
      return endDateMs !== null && endDateMs <= nowMs;
    });
    for (const row of listedPolymarket) {
      marketsRepo.setStatus(this.db, row.market_id, "frozen");
      frozen += 1;
    }
    return frozen;
  }

  // ─── Candidate assembly ───────────────────────────────────────────────────

  /**
   * In-flight ledger rows (draft/broadcasting/confirmed) that the fresh
   * window no longer returns still need reconciliation — a daemon crash
   * between broadcast and promotion must not strand them. They are
   * prepended so recovery work happens before new spend.
   */
  private mergeLedgerCandidates(
    fresh: DiscoveryCandidate[],
    nowMs: number,
  ): DiscoveryCandidate[] {
    const freshIds = new Set(fresh.map((candidate) => candidate.conditionId));
    const recovered: DiscoveryCandidate[] = [];
    for (const row of polymarketDiscoveryRepo.listUnsettled(
      this.db,
      LEDGER_SCAN_LIMIT,
    )) {
      if (freshIds.has(row.condition_id)) continue;
      if (row.end_date_epoch_s * 1000 <= nowMs) continue;
      recovered.push({
        conditionId: row.condition_id,
        question: row.question,
        slug: row.slug,
        endDateEpochSec: row.end_date_epoch_s,
        snapshot: null,
      });
    }
    return [...recovered, ...fresh];
  }

  // ─── Per-candidate state machine ──────────────────────────────────────────

  private async processCandidate(
    candidate: DiscoveryCandidate,
    opts: { nowMs: number; allowChainWrite: boolean; spend: TickSpendState },
  ): Promise<CandidateOutcome> {
    const { conditionId, endDateEpochSec } = candidate;
    const now_iso = isoFromMs(opts.nowMs);
    const ledger = polymarketDiscoveryRepo.get(this.db, conditionId);
    // Terminal statuses need an operator, not a retry loop: `failed` rows
    // already fired an alert, `frozen` windows are over.
    if (ledger && (ledger.status === "failed" || ledger.status === "frozen")) {
      return "skipped";
    }
    // Not enough runway left to complete a NEW registration. Fresh
    // candidates without history aren't worth a chain read; rows discovery
    // already owns still get reconciled below — a listed market stays
    // listed until its endDate, and confirmed chain state still promotes.
    const leadShort =
      endDateEpochSec * 1000 - opts.nowMs < this.config.minLeadSec * 1000;
    if (leadShort && !ledger) {
      return "skipped";
    }

    // On-chain truth FIRST. A DB row is never treated as proof of
    // registration — that exact shortcut produced the live phantom-market
    // failure this ticker exists to prevent.
    let chainState;
    try {
      chainState = await this.registrar.getMarket(conditionId as Hex);
    } catch (err) {
      this.recordCandidateError(conditionId, `chain_read:${describe(err)}`, now_iso);
      return "abort";
    }
    const exact = hasExactFixedRevealState(chainState, BigInt(endDateEpochSec));
    const market = marketsRepo.get(this.db, conditionId);

    if (exact) {
      if (endDateEpochSec * 1000 <= opts.nowMs) {
        // Window closed mid-tick — registered on-chain but never listable.
        this.freezeCandidate(conditionId, "window_ended", now_iso);
        return "frozen";
      }
      if (ledger?.status === "listed" && market?.status === "listed") {
        return "skipped";
      }
      return this.promoteCandidate(candidate, ledger, market, now_iso);
    }

    // Chain is absent or mismatched. A `listed` DB row is now a phantom —
    // freeze it immediately; repair (below) relists after a verified write.
    if (market?.status === "listed") {
      marketsRepo.setStatus(this.db, conditionId, "frozen");
    }
    if (leadShort) {
      // No time left to repair before the window closes; the market row (if
      // any) is already frozen above, so nothing agent-facing remains.
      this.freezeCandidate(conditionId, "lead_time_elapsed", now_iso);
      return "frozen";
    }
    if (isRegisteredOnchain(chainState)) {
      // Mismatched on-chain config: re-registering overwrites it, so this
      // is an explicit audited repair, not a silent upsert.
      this.logger.warn(
        `[polymarket-discovery] repairing on-chain mismatch for ${conditionId}: ` +
          `horizon=${chainState.horizonSeconds} fixedRevealAfter=${chainState.fixedRevealAfter} ` +
          `active=${chainState.active} expected fixedRevealAfter=${endDateEpochSec}`,
      );
    }

    // A persisted broadcast hash must be reconciled before any replacement
    // write: a still-pending tx would otherwise be double-spent every tick
    // until its receipt lands.
    if (ledger?.status === "broadcasting" && ledger.tx_hash) {
      const priorReceipt = await this.registrar.getReceipt(ledger.tx_hash as Hex);
      if (priorReceipt === null) {
        const broadcastAgeMs = opts.nowMs - Date.parse(ledger.updated_at);
        if (!Number.isFinite(broadcastAgeMs) || broadcastAgeMs < BROADCAST_PENDING_GRACE_MS) {
          return "skipped";
        }
        // Past the grace window with no receipt: assume dropped and rebroadcast.
      } else if (priorReceipt.status === "reverted") {
        this.recordCandidateError(
          conditionId,
          `prior_tx_reverted:${ledger.tx_hash}`,
          now_iso,
        );
      }
      // A success receipt with non-exact chain state means the registration
      // was overwritten afterwards — fall through to the audited repair.
    }

    if (!opts.allowChainWrite) {
      return "skipped";
    }
    if ((ledger?.attempt_count ?? 0) >= MAX_BROADCAST_ATTEMPTS) {
      polymarketDiscoveryRepo.upsertDraft(this.db, this.draftRow(candidate, now_iso));
      polymarketDiscoveryRepo.markFailed(this.db, {
        condition_id: conditionId,
        error: `max_broadcast_attempts:${MAX_BROADCAST_ATTEMPTS}`,
        now_iso,
      });
      return "skipped";
    }

    // Stage DB state BEFORE spending gas: ledger draft + `draft` markets
    // row. Draft markets are invisible to /v1/markets and rejected by the
    // Gateway preflight, so a crash here leaves nothing agent-facing.
    const staged = await this.stageDraft(candidate, ledger, market !== null, now_iso);
    if (!staged) return "skipped";

    return this.broadcastRegistration(candidate, opts);
  }

  private async promoteCandidate(
    candidate: DiscoveryCandidate,
    ledger: PolymarketDiscoveryStateRow | null,
    market: MarketRow | null,
    now_iso: string,
  ): Promise<CandidateOutcome> {
    // Chain already carries the exact fixed-reveal state; only the DB needs
    // work (crash after receipt, or market registered out-of-band).
    if (!market) {
      const registered = await this.registerDraftMarketRow(candidate, now_iso);
      if (!registered) return "skipped";
    } else if (market.status !== "draft" && market.status !== "listed") {
      // Promotion is sanctioned for missing/draft rows and for finishing
      // discovery's own mid-registration repair freeze. Any other frozen or
      // retired row is an operator decision — relisting it here would undo
      // a deliberate halt on every tick.
      const discoveryMidFlight =
        market.status === "frozen" &&
        (ledger?.status === "broadcasting" || ledger?.status === "confirmed");
      if (!discoveryMidFlight) return "skipped";
    }
    this.db.transaction(() => {
      polymarketDiscoveryRepo.upsertDraft(this.db, this.draftRow(candidate, now_iso));
      marketsRepo.setStatus(this.db, candidate.conditionId, "listed");
      polymarketDiscoveryRepo.markListed(this.db, {
        condition_id: candidate.conditionId,
        now_iso,
      });
    })();
    return "promoted";
  }

  private async stageDraft(
    candidate: DiscoveryCandidate,
    ledger: PolymarketDiscoveryStateRow | null,
    marketRowExists: boolean,
    now_iso: string,
  ): Promise<boolean> {
    if (!ledger) {
      polymarketDiscoveryRepo.upsertDraft(this.db, this.draftRow(candidate, now_iso));
    }
    if (!marketRowExists) {
      return this.registerDraftMarketRow(candidate, now_iso);
    }
    return true;
  }

  private async registerDraftMarketRow(
    candidate: DiscoveryCandidate,
    now_iso: string,
  ): Promise<boolean> {
    let snapshot = candidate.snapshot;
    if (!snapshot) {
      const fetched = await this.gamma.fetchMarketByConditionId(
        candidate.conditionId,
      );
      if (!fetched.snapshot) {
        this.recordCandidateError(
          candidate.conditionId,
          `gamma_lookup:${fetched.error ?? "no_snapshot"}`,
          now_iso,
        );
        return false;
      }
      snapshot = fetched.snapshot;
      // The ledger's endDate drove chain reconciliation and the register
      // write; a refetched snapshot with a different endDate would persist a
      // config the acceptance guard can never match. Fail closed instead.
      const refetchedEndMs =
        typeof snapshot.endDate === "string"
          ? Date.parse(snapshot.endDate)
          : Number.NaN;
      if (
        !Number.isFinite(refetchedEndMs) ||
        Math.floor(refetchedEndMs / 1000) !== candidate.endDateEpochSec
      ) {
        this.recordCandidateError(
          candidate.conditionId,
          `gamma_end_date_drift:${snapshot.endDate ?? "missing"} != ${candidate.endDateEpochSec}`,
          now_iso,
        );
        return false;
      }
    }
    const gammaLookup: PolymarketMarketRegistrationGammaAdapter = {
      fetchMarketByConditionId: async () => ({ snapshot, error: null }),
    };
    const registration = await runPolymarketMarketRegistration({
      db: this.db,
      conditionId: candidate.conditionId,
      status: "draft",
      // Stable horizon: the window duration, not "time remaining at
      // registration" (which would drift across retries).
      horizon_seconds: this.config.windowDurationSec,
      actor: "polymarket_discovery",
      gammaLookup,
      newAgentSecurityEventId: this.newAgentSecurityEventId,
      now: this.now,
    });
    if (registration.status !== 201) {
      this.recordCandidateError(
        candidate.conditionId,
        `db_register:${registration.status}:${JSON.stringify(registration.body).slice(0, 200)}`,
        now_iso,
      );
      return false;
    }
    return true;
  }

  private async broadcastRegistration(
    candidate: DiscoveryCandidate,
    opts: { nowMs: number; spend: TickSpendState },
  ): Promise<CandidateOutcome> {
    const { conditionId, endDateEpochSec } = candidate;
    const marketId = conditionId as Hex;
    const revealAfterSec = BigInt(endDateEpochSec);
    const now_iso = isoFromMs(this.now().getTime());

    // Spend ceiling per write. A gas spike affects every candidate, so a
    // breach stops the remainder of the tick rather than trying the next.
    let costWei: bigint;
    try {
      costWei = await this.registrar.estimateRegisterCostWei(
        marketId,
        revealAfterSec,
      );
    } catch (err) {
      this.recordCandidateError(conditionId, `estimate:${describe(err)}`, now_iso);
      return "abort";
    }
    if (costWei > this.config.maxRegisterCostWei) {
      this.recordCandidateError(
        conditionId,
        `cost_ceiling:${costWei} > ${this.config.maxRegisterCostWei}`,
        now_iso,
      );
      return "abort";
    }
    if (
      opts.spend.balanceWei !== null &&
      opts.spend.balanceWei - costWei < this.config.minBalanceWei
    ) {
      this.recordCandidateError(
        conditionId,
        `balance_reserve:${opts.spend.balanceWei} - ${costWei} < ${this.config.minBalanceWei}`,
        now_iso,
      );
      return "abort";
    }

    polymarketDiscoveryRepo.markBroadcasting(this.db, {
      condition_id: conditionId,
      now_iso,
    });
    let hash: Hex;
    try {
      hash = await this.registrar.registerFixedRevealMarket(
        marketId,
        revealAfterSec,
      );
    } catch (err) {
      // Nonce, RPC, and ownership failures poison every later broadcast on
      // this key — stop the tick; the ledger row reconciles next tick.
      this.recordCandidateError(conditionId, `broadcast:${describe(err)}`, now_iso);
      return "abort";
    }
    // Gas is spent whether or not the receipt succeeds; the estimated cost
    // keeps the shared reserve check honest for the rest of the tick.
    if (opts.spend.balanceWei !== null) {
      opts.spend.balanceWei -= costWei;
    }
    polymarketDiscoveryRepo.recordBroadcastHash(this.db, {
      condition_id: conditionId,
      tx_hash: hash,
      now_iso: isoFromMs(this.now().getTime()),
    });

    let receipt;
    try {
      receipt = await this.registrar.waitForReceipt(hash);
    } catch (err) {
      // Hash persisted above — next tick reads markets(conditionId) and
      // promotes without a second transaction if this one landed.
      this.recordCandidateError(conditionId, `receipt:${describe(err)}`, now_iso);
      return "abort";
    }
    const settledIso = isoFromMs(this.now().getTime());
    if (receipt.status === "reverted") {
      const revertedGas = {
        gas_used: receipt.gasUsed?.toString() ?? null,
        effective_gas_price_wei: receipt.effectiveGasPriceWei?.toString() ?? null,
      };
      const endPassed = endDateEpochSec * 1000 <= this.now().getTime();
      if (endPassed) {
        // RevealAfterMustBeFuture: the window closed under us. Freeze; a
        // retry can never succeed.
        this.freezeCandidate(
          conditionId,
          "reverted:window_ended",
          settledIso,
          revertedGas,
        );
        return "frozen";
      }
      polymarketDiscoveryRepo.markFailed(this.db, {
        condition_id: conditionId,
        error: "receipt_reverted",
        ...revertedGas,
        now_iso: settledIso,
      });
      return "abort";
    }

    const endStillFuture = endDateEpochSec * 1000 > this.now().getTime();
    this.db.transaction(() => {
      polymarketDiscoveryRepo.markConfirmed(this.db, {
        condition_id: conditionId,
        tx_hash: hash,
        gas_used: receipt.gasUsed?.toString() ?? null,
        effective_gas_price_wei: receipt.effectiveGasPriceWei?.toString() ?? null,
        now_iso: settledIso,
      });
      if (endStillFuture) {
        marketsRepo.setStatus(this.db, conditionId, "listed");
        polymarketDiscoveryRepo.markListed(this.db, {
          condition_id: conditionId,
          now_iso: settledIso,
        });
      } else {
        // Receipt landed after the window ended — registered on-chain but
        // never listable. Freeze instead of exposing a dead market.
        marketsRepo.setStatus(this.db, conditionId, "frozen");
        polymarketDiscoveryRepo.markFrozen(this.db, {
          condition_id: conditionId,
          reason: "confirmed_after_end",
          now_iso: settledIso,
        });
      }
    })();
    return "registered";
  }

  // ─── Small helpers ────────────────────────────────────────────────────────

  private draftRow(candidate: DiscoveryCandidate, now_iso: string) {
    return {
      condition_id: candidate.conditionId,
      question: candidate.question,
      slug: candidate.slug,
      end_date_epoch_s: candidate.endDateEpochSec,
      now_iso,
    };
  }

  private freezeCandidate(
    conditionId: string,
    reason: string,
    now_iso: string,
    gas?: { gas_used: string | null; effective_gas_price_wei: string | null },
  ): void {
    this.db.transaction(() => {
      polymarketDiscoveryRepo.markFrozen(this.db, {
        condition_id: conditionId,
        reason,
        ...gas,
        now_iso,
      });
      const market = marketsRepo.get(this.db, conditionId);
      if (market && (market.status === "listed" || market.status === "draft")) {
        marketsRepo.setStatus(this.db, conditionId, "frozen");
      }
    })();
  }

  private recordCandidateError(
    conditionId: string,
    error: string,
    now_iso: string,
  ): void {
    this.logger.warn(`[polymarket-discovery] ${conditionId}: ${error}`);
    if (polymarketDiscoveryRepo.get(this.db, conditionId)) {
      polymarketDiscoveryRepo.recordError(this.db, {
        condition_id: conditionId,
        error,
        now_iso,
      });
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
