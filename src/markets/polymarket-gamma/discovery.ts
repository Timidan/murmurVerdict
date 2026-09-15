/**
 * Polymarket Up-or-Down auto-discovery. Registers each imminent window as a
 * `draft` market row and on-chain via `registerFixedRevealMarket`, and lists
 * it only after the chain state is verified.
 *
 * Chain state, never the DB row, is proof of registration. The
 * `polymarket_discovery_state` ledger survives crashes so lost receipts
 * reconcile from chain instead of re-spending gas.
 */

import type Database from "better-sqlite3";
import type { Hex } from "viem";

import {
  hasExactSchedule,
  LegacyContractError,
  type OnchainSchedule,
  isRegisteredOnchain,
  type FhenixMarketRegistrar,
} from "../../integrations/fhenix-market-registration.js";
import type { AgentSecurityEventIdAdapter } from "../../verdict/agent-security-event.js";
import { endDateMsForMarketConfig } from "../../verdict/market-adapter-config.js";
import {
  DISCOVERY_ACTOR,
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
import {
  deriveSeriesClock,
  isRegistrable,
  type SeriesClockConfig,
} from "../../verdict/series-clock.js";
import {
  marketClocksRepo,
  marketSeriesRepo,
  SeriesCapConflictError,
  SeriesClockConflictError,
} from "../../verdict/repos/market-clocks-repo.js";
import { isoFromMs, nowIso } from "../../verdict/time.js";
import type { FetchWindowInput, FetchWindowResult } from "./client.js";
import { parseOutcomeLabels, type GammaMarketSnapshot } from "./transform.js";

const CONDITION_ID_REGEX = /^0x[0-9a-f]{64}$/;
const MAX_BROADCAST_ATTEMPTS = 5;
/** The register tx must confirm before armCloseAt; 30s covers broadcast plus a slow block. */
const REGISTRATION_BROADCAST_MARGIN_MS = 30_000;
const LEDGER_SCAN_LIMIT = 200;
// How long a broadcast hash with no receipt counts as still pending.
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
  /** Accepted window lengths (seconds), parsed from each question. Each is its own series. */
  windowDurationSecs: number[];
  /** Clock constants shared by every window; must match each stored `market_series` row. */
  seriesClock: SeriesClockConfig;
  /**
   * Sales limit per call, not a gas bound: each grant is its own tx, so size
   * it from grantor funding and what confirms inside the delivery budget.
   */
  maxArmedPerCall: number;
  /** Bump to intentionally adopt new clock constants. See seriesId(). */
  seriesVersion: number;
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
  /** Fills `events[0].tags`, which `/markets` omits. Best-effort: on failure the market registers uncategorised. */
  enrichSnapshotEventTags?(
    snapshot: GammaMarketSnapshot,
  ): Promise<GammaMarketSnapshot>;
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
  /** Parsed from this market's question; decides its schedule and series. */
  windowSec: number;
  /** Present for freshly fetched windows; null for ledger-recovered rows. */
  snapshot: GammaMarketSnapshot | null;
}

export interface DiscoveryCandidateFilter {
  nowMs: number;
  minLeadSec: number;
  /**
   * Rejects candidates whose arm window has closed. minLeadSec alone isn't
   * enough: such a candidate reverts at gas estimation and heads the queue
   * again every tick.
   */
  seriesClock: SeriesClockConfig;
  questionFilter: string;
  assets: string[];
  windowDurationSecs: readonly number[];
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
      // Word-bounded: "Bitcoin" won't match "Bitcoincash", but "Ethereum"
      // still matches "Ethereum Classic".
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
    // 5/10/15-minute series share one question shape and Gamma's startDate is
    // creation time, so the window comes from the question ("7:15PM-7:20PM ET").
    const windowSec = parseQuestionWindowDurationSec(question);
    if (windowSec === null || !filter.windowDurationSecs.includes(windowSec)) {
      continue;
    }
    if (typeof snapshot.endDate !== "string") continue;
    const endMs = Date.parse(snapshot.endDate);
    if (!Number.isFinite(endMs)) continue;
    // Chain stores whole seconds; acceptance compares ms.
    if (endMs % 1000 !== 0) continue;
    if (endMs - filter.nowMs < filter.minLeadSec * 1000) continue;
    if (
      !isRegistrable(
        deriveSeriesClock({
          endDateMs: endMs,
          windowSec,
          config: filter.seriesClock,
        }),
        filter.nowMs,
      )
    ) {
      continue;
    }
    seen.add(conditionId);
    candidates.push({
      conditionId,
      question,
      slug: typeof snapshot.slug === "string" ? snapshot.slug : null,
      endDateEpochSec: Math.floor(endMs / 1000),
      windowSec,
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
 * Window length in seconds from the question's clock range
 * ("7:15PM-7:20PM ET" → 300, "11:55PM-12:00AM" → 300). Null if unrecognized.
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
  /** Registrations stamped by recovery this tick; they consume the write budget too. */
  recovered: number;
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
    this.assertSeriesConfigUnchanged();

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
      // DB-only sweep first so ended markets freeze even with the RPC down.
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
        seriesClock: this.config.seriesClock,
        questionFilter: this.config.questionFilter,
        assets: this.config.assets,
        windowDurationSecs: this.config.windowDurationSecs,
      });
      const candidates = this.mergeLedgerCandidates(fresh, tickedAtMs);

      // Per-tick cap plus persisted hourly/daily caps.
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

      // Each broadcast decrements the balance so later candidates check the reserve against what's left.
      const spend: TickSpendState = { balanceWei, recovered: 0 };
      for (const candidate of candidates) {
        const allowChainWrite =
          balanceStatus !== "critical" &&
          result.registered + spend.recovered < budget;
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

  /** Before any owner-key write: right chain, contract has code, owner is our relayer. */
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

  /** Freeze ended markets, including polymarket rows the ledger never saw. Frozen markets still resolve. */
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

  /** Re-queue in-flight ledger rows the window no longer returns, ahead of new spend. */
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
      const windowSec = this.ledgerCandidateWindowSec(row);
      if (windowSec === null) {
        // Never guess a window; freezeExpired settles the row later.
        this.logger.warn(
          `[polymarket-discovery] ${row.condition_id}: cannot determine window ` +
            `length from its clock snapshot or question — skipping recovery`,
        );
        continue;
      }
      recovered.push({
        conditionId: row.condition_id,
        question: row.question,
        slug: row.slug,
        endDateEpochSec: row.end_date_epoch_s,
        windowSec,
        snapshot: null,
      });
    }
    return [...recovered, ...fresh];
  }

  /** Window of an owned row: its bound clock snapshot (resolution − submissionClose), else the question. */
  private ledgerCandidateWindowSec(
    row: PolymarketDiscoveryStateRow,
  ): number | null {
    const bound = marketClocksRepo.get(this.db, row.condition_id);
    if (bound && bound.derived_from_end_date_ms === row.end_date_epoch_s * 1000) {
      const windowSec =
        (bound.resolution_at_ms - bound.submission_close_at_ms) / 1000;
      if (Number.isInteger(windowSec) && windowSec > 0) return windowSec;
    }
    return row.question === null
      ? null
      : parseQuestionWindowDurationSec(row.question);
  }

  // ─── Per-candidate state machine ──────────────────────────────────────────

  private async processCandidate(
    candidate: DiscoveryCandidate,
    opts: { nowMs: number; allowChainWrite: boolean; spend: TickSpendState },
  ): Promise<CandidateOutcome> {
    // Operator halt wins; check before any staging or chain write.
    if (marketsRepo.isOperatorHalted(this.db, candidate.conditionId)) {
      return "skipped";
    }
    const { conditionId, endDateEpochSec } = candidate;
    const now_iso = isoFromMs(opts.nowMs);
    let ledger = polymarketDiscoveryRepo.get(this.db, conditionId);
    // failed/frozen need an operator, not a retry.
    if (ledger && (ledger.status === "failed" || ledger.status === "frozen")) {
      return "skipped";
    }
    // Too late for a NEW registration; rows we already own still reconcile below.
    const leadShort =
      endDateEpochSec * 1000 - opts.nowMs < this.config.minLeadSec * 1000;
    if (leadShort && !ledger) {
      return "skipped";
    }

    // Chain state first: a DB row is never proof of registration.
    let chainState;
    try {
      chainState = await this.registrar.getMarket(conditionId as Hex);
    } catch (err) {
      // A legacy contract is a config fault; surface it loudly.
      if (err instanceof LegacyContractError) throw err;
      this.recordCandidateError(conditionId, `chain_read:${describe(err)}`, now_iso);
      return "abort";
    }
    const expectedSchedule = this.expectedSchedule(candidate);
    const exact = hasExactSchedule(chainState, expectedSchedule);
    const market = marketsRepo.get(this.db, conditionId);

    if (exact) {
      // Stamp registrations whose receipt we missed so the spend caps count them.
      this.stampRecoveredRegistration(candidate, ledger, opts.spend, now_iso, {
        tx_hash: ledger?.tx_hash ?? null,
        gas_used: null,
        effective_gas_price_wei: null,
      });
      ledger = polymarketDiscoveryRepo.get(this.db, conditionId);
      if (endDateEpochSec * 1000 <= opts.nowMs) {
        // Window closed mid-tick: registered but never listable.
        this.freezeCandidate(conditionId, "window_ended", now_iso);
        return "frozen";
      }
      if (ledger?.status === "listed" && market?.status === "listed") {
        return "skipped";
      }
      return this.promoteCandidate(candidate, ledger, market, now_iso);
    }

    // Chain absent or mismatched: a `listed` row is a phantom. Repair relists after a verified write.
    if (market?.status === "listed") {
      marketsRepo.setStatus(this.db, conditionId, "frozen");
    }
    if (leadShort) {
      this.freezeCandidate(conditionId, "lead_time_elapsed", now_iso);
      return "frozen";
    }
    if (isRegisteredOnchain(chainState)) {
      // Schedules are one-shot and buyers paid against them: never retime.
      // Usually Gamma moved endDate; freeze and let delist/refund settle it.
      this.logger.warn(
        `[polymarket-discovery] on-chain schedule mismatch for ${conditionId} — ` +
          `freezing (schedules are immutable once registered). ` +
          `chain: armClose=${chainState.armCloseAt} submissionClose=${chainState.submissionCloseAt} ` +
          `resolution=${chainState.resolutionAt} publicReveal=${chainState.publicRevealAt} ` +
          `active=${chainState.active}; expected resolution=${endDateEpochSec}`,
      );
      this.freezeCandidate(conditionId, "onchain_schedule_mismatch", now_iso, undefined, candidate);
      return "frozen";
    }

    // Reconcile a persisted broadcast before any new write.
    if (ledger?.status === "broadcasting" && ledger.tx_hash) {
      const priorReceipt = await this.registrar.getReceipt(ledger.tx_hash as Hex);
      if (priorReceipt === null) {
        const broadcastAgeMs = opts.nowMs - Date.parse(ledger.updated_at);
        if (!Number.isFinite(broadcastAgeMs) || broadcastAgeMs < BROADCAST_PENDING_GRACE_MS) {
          return "skipped";
        }
        // No receipt past grace. Don't rebroadcast: it may be RPC lag, and a
        // new nonce would gap the shared relayer lane. Safe recovery needs
        // same-nonce fee bumping, so leave it to the operator.
        this.recordCandidateError(
          conditionId,
          `broadcast_unconfirmed_past_grace:${ledger.tx_hash} age=${Math.floor(broadcastAgeMs / 1000)}s`,
          now_iso,
        );
        return "skipped";
      } else if (priorReceipt.status === "reverted") {
        this.recordCandidateError(
          conditionId,
          `prior_tx_reverted:${ledger.tx_hash}`,
          now_iso,
        );
      } else {
        // Success: chainState predates this receipt, so re-read.
        const freshState = await this.registrar.getMarket(conditionId as Hex);
        if (hasExactSchedule(freshState, expectedSchedule)) {
          this.stampRecoveredRegistration(candidate, ledger, opts.spend, now_iso, {
            tx_hash: ledger.tx_hash,
            gas_used: priorReceipt.gasUsed?.toString() ?? null,
            effective_gas_price_wei:
              priorReceipt.effectiveGasPriceWei?.toString() ?? null,
          });
          return this.promoteCandidate(
            candidate,
            polymarketDiscoveryRepo.get(this.db, conditionId),
            marketsRepo.get(this.db, conditionId),
            now_iso,
          );
        }
        // Registered but mismatched: never retime.
        if (isRegisteredOnchain(freshState)) {
          this.freezeCandidate(
            conditionId,
            "onchain_schedule_mismatch",
            now_iso,
            undefined,
            candidate,
          );
          return "frozen";
        }
        // Success receipt but unregistered read: likely RPC lag. Retry reads next tick.
        this.recordCandidateError(
          conditionId,
          `receipt_success_but_unregistered:${ledger.tx_hash}`,
          now_iso,
        );
        return "skipped";
      }
    }

    // Recovery rows skip the lead filter and can be past armCloseAt; they would
    // revert at estimation and head the queue every tick. Must stay after the
    // receipt branch so an in-flight tx isn't stranded, and use the bound
    // schedule (not current config) plus the broadcast margin.
    if (
      !isRegisteredOnchain(chainState) &&
      opts.nowMs >= Number(expectedSchedule.armCloseAt) * 1000 - REGISTRATION_BROADCAST_MARGIN_MS
    ) {
      this.freezeCandidate(conditionId, "arm_window_closed", now_iso, undefined, candidate);
      return "frozen";
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

    // Stage DB state before spending gas; drafts are invisible to agents.
    const staged = await this.stageDraft(candidate, ledger, market !== null, now_iso);
    if (!staged) return "skipped";

    return this.broadcastRegistration(candidate, opts);
  }

  /**
   * Stamp an unrecorded registration and charge it to this tick's budget.
   * Creates the ledger row first (the stamp is an UPDATE); rows already
   * stamped aren't recounted.
   */
  private stampRecoveredRegistration(
    candidate: DiscoveryCandidate,
    ledger: PolymarketDiscoveryStateRow | null,
    spend: TickSpendState,
    now_iso: string,
    tx: {
      tx_hash: string | null;
      gas_used: string | null;
      effective_gas_price_wei: string | null;
    },
  ): void {
    if (ledger?.registered_onchain_at) return;
    if (!ledger) {
      polymarketDiscoveryRepo.upsertDraft(
        this.db,
        this.draftRow(candidate, now_iso),
      );
    }
    const stamped = polymarketDiscoveryRepo.stampRegisteredOnchain(this.db, {
      condition_id: candidate.conditionId,
      tx_hash: tx.tx_hash,
      gas_used: tx.gas_used,
      effective_gas_price_wei: tx.effective_gas_price_wei,
      now_iso,
    });
    if (stamped) spend.recovered += 1;
  }

  private async promoteCandidate(
    candidate: DiscoveryCandidate,
    ledger: PolymarketDiscoveryStateRow | null,
    market: MarketRow | null,
    now_iso: string,
  ): Promise<CandidateOutcome> {
    // Operator halt outranks every promotion.
    if (marketsRepo.isOperatorHalted(this.db, candidate.conditionId)) {
      return "skipped";
    }
    // Chain is already right; only the DB needs work.
    if (!market) {
      const registered = await this.registerDraftMarketRow(candidate, now_iso);
      if (!registered) return "skipped";
    } else if (market.status !== "draft" && market.status !== "listed") {
      // Only discovery's own mid-registration freeze may be relisted; other
      // frozen/retired rows are operator decisions.
      const discoveryMidFlight =
        market.status === "frozen" &&
        (ledger?.status === "broadcasting" || ledger?.status === "confirmed");
      if (!discoveryMidFlight) return "skipped";
    }
    // List only inside the submission window (fresh time) and with a matching
    // schedule snapshot; otherwise the contract rejects every submission.
    const schedule = this.expectedSchedule(candidate);
    if (this.now().getTime() >= Number(schedule.submissionCloseAt) * 1000) {
      this.logger.warn(
        `[polymarket-discovery] refusing to list ${candidate.conditionId}: ` +
          `submission window already closed`,
      );
      this.freezeCandidate(
        candidate.conditionId,
        "submission_window_closed",
        now_iso,
        undefined,
        candidate,
      );
      return "frozen";
    }
    if (!this.hasExactScheduleSnapshot(candidate)) {
      this.logger.warn(
        `[polymarket-discovery] refusing to list ${candidate.conditionId}: ` +
          `no matching schedule snapshot (unscheduled or stale draft)`,
      );
      this.freezeCandidate(candidate.conditionId, "missing_schedule_snapshot", now_iso, undefined, candidate);
      return "frozen";
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
    // An existing row may have no schedule (e.g. an admin draft); the
    // idempotent schedule-aware registration binds one.
    if (!this.hasExactScheduleSnapshot(candidate)) {
      // A conflicting snapshot can't be repaired, and registering would waste
      // a one-shot tx on a market that can't list. Freeze first.
      const existing = marketClocksRepo.get(this.db, candidate.conditionId);
      if (existing) {
        this.logger.warn(
          `[polymarket-discovery] ${candidate.conditionId} has a conflicting schedule ` +
            `snapshot (derived from endDate ${existing.derived_from_end_date_ms}, ` +
            `candidate has ${candidate.endDateEpochSec * 1000}) — freezing rather than ` +
            `spending gas on a registration that could not be listed`,
        );
        this.freezeCandidate(
          candidate.conditionId,
          "conflicting_schedule_snapshot",
          now_iso,
          undefined,
          candidate,
        );
        return false;
      }
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
      // A refetch with a different endDate would store a config acceptance can never match.
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
    if (this.gamma.enrichSnapshotEventTags) {
      // One extra request per registration; a category must never block one.
      try {
        snapshot = await this.gamma.enrichSnapshotEventTags(snapshot);
      } catch {
        // registers uncategorised
      }
    }
    const gammaLookup: PolymarketMarketRegistrationGammaAdapter = {
      fetchMarketByConditionId: async () => ({ snapshot, error: null }),
    };
    const registration = await runPolymarketMarketRegistration({
      db: this.db,
      conditionId: candidate.conditionId,
      status: "draft",
      // Window length, not time remaining, so retries agree.
      horizon_seconds: candidate.windowSec,
      actor: DISCOVERY_ACTOR,
      // Written atomically with the market row.
      schedule: {
        seriesId: this.seriesId(candidate.windowSec),
        displayName: `polymarket ${candidate.windowSec}s binary`,
        windowSeconds: candidate.windowSec,
        clockConfig: this.config.seriesClock,
        maxArmedPerCall: this.config.maxArmedPerCall,
      },
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

  /**
   * Fail the tick, before touching any market, if runtime clock constants
   * differ from any configured window's stored series. Otherwise every live
   * market reads as an on-chain mismatch and freezes.
   */
  private assertSeriesConfigUnchanged(): void {
    for (const windowSec of this.config.windowDurationSecs) {
      this.assertSeriesUnchangedForWindow(windowSec);
    }
  }

  private assertSeriesUnchangedForWindow(windowSec: number): void {
    const seriesId = this.seriesId(windowSec);
    const stored = marketSeriesRepo.get(this.db, seriesId);
    if (!stored) return;
    const c = this.config.seriesClock;
    const same =
      stored.submission_open_lead_sec === c.submissionOpenLeadSec &&
      stored.commit_margin_sec === c.commitMarginSec &&
      stored.delivery_budget_sec === c.deliveryBudgetSec &&
      stored.embargo_sec === c.embargoSec &&
      stored.window_seconds === windowSec;
    // The cohort cap is part of the series contract.
    if (stored.max_armed_per_call !== this.config.maxArmedPerCall) {
      throw new SeriesCapConflictError(
        seriesId,
        stored.max_armed_per_call,
        this.config.maxArmedPerCall,
      );
    }
    if (!same) {
      throw new SeriesClockConflictError(
        seriesId,
        {
          submissionOpenLeadSec: stored.submission_open_lead_sec,
          commitMarginSec: stored.commit_margin_sec,
          deliveryBudgetSec: stored.delivery_budget_sec,
          embargoSec: stored.embargo_sec,
        },
        c,
      );
    }
  }

  /**
   * The market's clock snapshot came from this endDate, its config carries
   * the matching embargo, and its series still exists.
   */
  private hasExactScheduleSnapshot(candidate: DiscoveryCandidate): boolean {
    const snap = marketClocksRepo.get(this.db, candidate.conditionId);
    if (!snap) return false;
    if (snap.derived_from_end_date_ms !== candidate.endDateEpochSec * 1000) return false;

    // An unscheduled re-upsert can strip embargoSec while leaving the clock row.
    const market = marketsRepo.get(this.db, candidate.conditionId);
    if (!market) return false;
    let embargoSec: unknown;
    try {
      embargoSec = (JSON.parse(market.config_json) as Record<string, unknown>).embargoSec;
    } catch {
      return false;
    }
    const impliedEmbargoSec =
      (snap.public_reveal_at_ms - snap.resolution_at_ms) / 1000;
    if (embargoSec !== impliedEmbargoSec) return false;

    return marketSeriesRepo.get(this.db, snap.series_id) !== null;
  }

  /** One series per window. Bump seriesVersion to give new markets new clock constants. */
  private seriesId(windowSec: number): string {
    return `polymarket:binary-${windowSec}s:v${this.config.seriesVersion}`;
  }

  private async broadcastRegistration(
    candidate: DiscoveryCandidate,
    opts: { nowMs: number; spend: TickSpendState },
  ): Promise<CandidateOutcome> {
    const { conditionId, endDateEpochSec } = candidate;
    const marketId = conditionId as Hex;
    const schedule = this.expectedSchedule(candidate);
    const now_iso = isoFromMs(this.now().getTime());

    // Spend ceiling per write; a gas spike hits every candidate, so abort the tick.
    let costWei: bigint;
    try {
      costWei = await this.registrar.estimateRegisterCostWei(marketId, schedule);
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

    // Re-check halt: an operator may have halted during the estimate, and the write is irreversible.
    if (marketsRepo.isOperatorHalted(this.db, conditionId)) {
      this.recordCandidateError(conditionId, "operator_halted_during_estimate", now_iso);
      return "skipped";
    }
    // ...and again right before broadcast, which may queue behind another relayer tx.
    const preBroadcast = () => {
      if (marketsRepo.isOperatorHalted(this.db, conditionId)) {
        throw new Error(`market ${conditionId} halted by operator before broadcast`);
      }
    };
    polymarketDiscoveryRepo.markBroadcasting(this.db, {
      condition_id: conditionId,
      now_iso,
      // New tx: restart the stuck-tx clock.
      resetWatermark: true,
    });
    let hash: Hex;
    try {
      hash = await this.registrar.registerMarket(marketId, schedule, { preBroadcast });
    } catch (err) {
      // Nonce/RPC/ownership failures poison later broadcasts; reconcile next tick.
      this.recordCandidateError(conditionId, `broadcast:${describe(err)}`, now_iso);
      return "abort";
    }
    // Gas is spent either way.
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
      // Hash is persisted; next tick promotes from chain if it landed.
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
        // Window closed under us; a retry can't succeed.
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
      // Same listing rules as promoteCandidate: fresh time inside the
      // submission window, a matching schedule snapshot, and no operator halt.
      const submissionStillOpen =
        this.now().getTime() < Number(schedule.submissionCloseAt) * 1000;
      const halted = marketsRepo.isOperatorHalted(this.db, conditionId);
      if (
        !halted &&
        endStillFuture &&
        submissionStillOpen &&
        this.hasExactScheduleSnapshot(candidate)
      ) {
        marketsRepo.setStatus(this.db, conditionId, "listed");
        polymarketDiscoveryRepo.markListed(this.db, {
          condition_id: conditionId,
          now_iso: settledIso,
        });
      } else {
        // Registered but not listable. A halted market keeps the operator's status.
        if (!halted) {
          marketsRepo.setStatus(this.db, conditionId, "frozen");
        }
        polymarketDiscoveryRepo.markFrozen(this.db, {
          condition_id: conditionId,
          reason: halted ? "operator_halted" : "confirmed_after_end",
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

  /** On-chain schedule; the one source for both the chain equality check and the register write. */
  private expectedSchedule(candidate: DiscoveryCandidate): OnchainSchedule {
    const { conditionId, endDateEpochSec } = candidate;
    // A bound market keeps its own snapshot; only new markets use current config.
    const bound = marketClocksRepo.get(this.db, conditionId);
    if (bound && bound.derived_from_end_date_ms === endDateEpochSec * 1000) {
      return {
        armCloseAt: BigInt(Math.floor(bound.arm_close_at_ms / 1000)),
        submissionOpenAt: BigInt(Math.floor(bound.submission_open_at_ms / 1000)),
        earlyAccessCutoffAt: BigInt(Math.floor(bound.early_access_cutoff_at_ms / 1000)),
        submissionCloseAt: BigInt(Math.floor(bound.submission_close_at_ms / 1000)),
        resolutionAt: BigInt(Math.floor(bound.resolution_at_ms / 1000)),
        publicRevealAt: BigInt(Math.floor(bound.public_reveal_at_ms / 1000)),
        active: true,
      };
    }
    const clock = deriveSeriesClock({
      endDateMs: endDateEpochSec * 1000,
      windowSec: candidate.windowSec,
      config: this.config.seriesClock,
    });
    return {
      armCloseAt: BigInt(Math.floor(clock.armCloseAtMs / 1000)),
      submissionOpenAt: BigInt(Math.floor(clock.submissionOpenAtMs / 1000)),
      earlyAccessCutoffAt: BigInt(Math.floor(clock.earlyAccessCutoffAtMs / 1000)),
      submissionCloseAt: BigInt(Math.floor(clock.submissionCloseAtMs / 1000)),
      resolutionAt: BigInt(Math.floor(clock.marketResolutionAtMs / 1000)),
      publicRevealAt: BigInt(Math.floor(clock.publicRevealAtMs / 1000)),
      active: true,
    };
  }

  /** Durable freeze. Seeds the ledger row first: markFrozen is an UPDATE, and a missing row is rediscovered every tick. */
  private freezeCandidate(
    conditionId: string,
    reason: string,
    now_iso: string,
    gas?: { gas_used: string | null; effective_gas_price_wei: string | null },
    candidate?: DiscoveryCandidate,
  ): void {
    this.db.transaction(() => {
      if (candidate) {
        polymarketDiscoveryRepo.upsertDraft(this.db, this.draftRow(candidate, now_iso));
      }
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
