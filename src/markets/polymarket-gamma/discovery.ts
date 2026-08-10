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

// ─── Constants ──────────────────────────────────────────────────────────────

const CONDITION_ID_REGEX = /^0x[0-9a-f]{64}$/;
const MAX_BROADCAST_ATTEMPTS = 5;
/**
 * How close to armCloseAt a registration may still be broadcast. The tx must
 * CONFIRM before the deadline (the contract rejects armCloseAt <= now), so a
 * margin narrower than broadcast + one Base block loses the race — measured
 * live losing it with seconds to spare. 30s covers a slow relay comfortably;
 * markets recur every window, so an over-frozen boundary candidate costs
 * nothing.
 */
const REGISTRATION_BROADCAST_MARGIN_MS = 30_000;
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
  /**
   * Series clock constants, validated by assertSeriesClockConfig. These derive
   * every on-chain instant from the market's endDate, so they must match what
   * is registered in `market_series` for this series.
   */
  seriesClock: SeriesClockConfig;
  /**
   * Cohort ceiling per call. An operational sales limit, NOT a gas bound —
   * each grant is its own transaction, so size this from grantor funding and
   * from how many grants can confirm inside the delivery budget.
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
  /**
   * Series clock. Selection must reject anything whose arm window has already
   * closed: `minLeadSec` alone is not enough, because registration needs
   * window + openLead + commitMargin of lead time, which is far more than the
   * minimum lead. Admitting such a candidate stages a draft, then reverts at
   * gas estimation (armCloseAt <= now), which aborts the whole tick — and
   * since estimation failures do not count as attempts, the same candidate
   * heads the queue again next tick and starves every registrable one behind
   * it.
   */
  seriesClock: SeriesClockConfig;
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
    // Registrable means "arming has not closed yet", which is strictly
    // stronger than the minimum lead.
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
  /**
   * Registrations newly stamped by recovery during this tick.
   *
   * The write budget is computed once before candidate processing, so a
   * recovery that discovers a previously uncounted registration must consume
   * budget too — otherwise later candidates spend the full pre-recovery
   * allowance and the persisted hourly/daily count exceeds its limit.
   */
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
    // Fail the tick BEFORE touching any market if the runtime clock constants
    // no longer match the persisted series. Deriving schedules from changed
    // constants would classify every already-registered market as an on-chain
    // mismatch and bulk-freeze live markets.
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
        seriesClock: this.config.seriesClock,
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
    // An operator halt is checked FIRST, before staging, estimation or any
    // chain write. Later checks alone were not enough: a halted market with no
    // ledger row still reached shared registration, which used to lift the
    // halt, and the receipt path then listed it.
    if (marketsRepo.isOperatorHalted(this.db, candidate.conditionId)) {
      return "skipped";
    }
    const { conditionId, endDateEpochSec } = candidate;
    const now_iso = isoFromMs(opts.nowMs);
    // Reassigned after a recovery stamp so downstream reads see current state.
    let ledger = polymarketDiscoveryRepo.get(this.db, conditionId);
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
      // A legacy deployment is a configuration fault, not a flaky read. Let it
      // escape so the daemon surfaces it loudly instead of burning a tick per
      // candidate forever against a contract it can never drive.
      if (err instanceof LegacyContractError) throw err;
      this.recordCandidateError(conditionId, `chain_read:${describe(err)}`, now_iso);
      return "abort";
    }
    const expectedSchedule = this.expectedSchedule(endDateEpochSec, conditionId);
    const exact = hasExactSchedule(chainState, expectedSchedule);
    const market = marketsRepo.get(this.db, conditionId);

    if (exact) {
      // Stamp the registration if the ledger never recorded it. A registration
      // whose receipt wait failed but which actually landed would otherwise
      // keep registered_onchain_at NULL, and the hourly/daily spend caps count
      // only that column — so recovered registrations were invisible to the
      // very limits meant to bound gas spend.
      this.stampRecoveredRegistration(candidate, ledger, opts.spend, now_iso, {
        tx_hash: ledger?.tx_hash ?? null,
        gas_used: null,
        effective_gas_price_wei: null,
      });
      // The stamp may have changed the row; re-read so the status checks below
      // and promoteCandidate see current state rather than the pre-stamp copy.
      ledger = polymarketDiscoveryRepo.get(this.db, conditionId);
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
      // FAIL CLOSED. Registration is one-shot on-chain, so a mismatch cannot be
      // repaired by re-registering — and it must not be. Consumers arm and
      // providers submit against a published schedule; silently rebinding it
      // would change the deal underneath them after they had paid.
      //
      // The usual cause is Gamma moving the market's endDate after we
      // registered. The correct response is to freeze this market and let the
      // delist/refund path settle anyone already armed, never to retime it.
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

    // A persisted broadcast hash must be reconciled before any replacement
    // write: a still-pending tx would otherwise be double-spent every tick
    // until its receipt lands. NOTE: we no longer rebroadcast at a fresh nonce —
    // see the past-grace branch below for why.
    if (ledger?.status === "broadcasting" && ledger.tx_hash) {
      const priorReceipt = await this.registrar.getReceipt(ledger.tx_hash as Hex);
      if (priorReceipt === null) {
        const broadcastAgeMs = opts.nowMs - Date.parse(ledger.updated_at);
        if (!Number.isFinite(broadcastAgeMs) || broadcastAgeMs < BROADCAST_PENDING_GRACE_MS) {
          return "skipped";
        }
        // Past the grace window with no receipt.
        //
        // We deliberately do NOT rebroadcast here. A missing receipt does not
        // prove the transaction is dead — the RPC may simply be lagging, and
        // transport failures are reported as "missing" too. Sending a
        // replacement takes the NEXT nonce from the shared relayer lane, so if
        // the original was merely slow we leave a gap that stalls every later
        // write from the same key, including the Gateway's. And if the
        // original does land, the one-shot contract rejects the duplicate.
        //
        // Correctly recovering a stuck tx needs same-nonce replacement with a
        // fee bump, which this engine has no transaction manager for. Until it
        // does, surface it and let the operator decide rather than risking the
        // shared nonce lane.
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
        // SUCCESS. The chain read above happened BEFORE this receipt landed,
        // so `chainState` is stale — it still says unregistered. Acting on it
        // would either freeze a registration that actually succeeded (the
        // terminal ledger row is then skipped forever, so the market is never
        // promoted) or broadcast a duplicate that the one-shot contract
        // rejects. Re-read and reconcile against fresh truth instead.
        const freshState = await this.registrar.getMarket(conditionId as Hex);
        if (hasExactSchedule(freshState, expectedSchedule)) {
          // Counts against this tick's budget for the same reason as the
          // exact-state branch above: it newly stamps a registration the
          // pre-tick budget did not know about.
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
        // Registered but not matching: same immutable-schedule rule as above.
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
        // Receipt succeeded yet the read says unregistered. A success receipt
        // proves execution, so this is far more likely RPC lag, a backend
        // inconsistency, or a reorg boundary than a genuinely absent
        // registration. Broadcasting again would spend gas on a one-shot call
        // the contract rejects. Record it and retry reads next tick.
        this.recordCandidateError(
          conditionId,
          `receipt_success_but_unregistered:${ledger.tx_hash}`,
          now_iso,
        );
        return "skipped";
      }
    }

    // A recovery row skips the fresh-candidate lead filter, so it can reach
    // here past armCloseAt. Registering it is impossible — the contract
    // rejects armCloseAt <= now — and attempting it reverts at gas estimation,
    // aborting the whole tick. Estimation failures do not increment
    // attempt_count, so the same row heads the queue again next tick and
    // starves every registrable candidate behind it.
    //
    // Placed AFTER the pending-receipt branch above, and this ordering is
    // load-bearing: a registration tx can still be in flight when armCloseAt
    // passes. Freezing before reconciling its receipt would strand a
    // registration that then SUCCEEDS on-chain — the terminal frozen ledger
    // row is skipped on later ticks, so the exact chain state is never
    // promoted. By here, a pending tx inside its grace window has already
    // returned "skipped", so only genuinely dead rows reach this check.
    //
    // The deadline comes from `expectedSchedule`, which returns a BOUND
    // market's own frozen snapshot. Re-deriving from current config here would
    // reintroduce the version-bump bug at this decision point: after a bump, a
    // v1-bound draft would be judged against v2's arm deadline — frozen too
    // early, or let through after its real v1 deadline had passed.
    //
    // WITH A BROADCAST MARGIN. Checking `now >= armCloseAt` exactly still let
    // a candidate through whose deadline fell during the broadcast itself —
    // seen live: armCloseAt 22:59:00, decision seconds earlier, tx mined
    // after, contract reverted RevealAfterMustBeFuture. The register tx has to
    // confirm before the deadline, so a candidate that cannot plausibly do
    // that is frozen here instead of burning gas on a doomed broadcast. Losing
    // a boundary market costs nothing — the venue lists another every window.
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

    // Stage DB state BEFORE spending gas: ledger draft + `draft` markets
    // row. Draft markets are invisible to /v1/markets and rejected by the
    // Gateway preflight, so a crash here leaves nothing agent-facing.
    const staged = await this.stageDraft(candidate, ledger, market !== null, now_iso);
    if (!staged) return "skipped";

    return this.broadcastRegistration(candidate, opts);
  }

  /**
   * Stamp a registration the ledger never recorded and charge it to THIS
   * tick's spend budget.
   *
   * The budget is computed once before candidate processing, so a recovery
   * that newly stamps a registration would otherwise leave the full
   * pre-recovery allowance available and let later candidates in the same tick
   * exceed the hourly/daily cap.
   *
   * Creates the ledger row first when there is none: the stamp is an UPDATE,
   * so an out-of-band registration with no row was silently not stamped and
   * stayed invisible to the caps permanently.
   *
   * The repo's `registered_onchain_at IS NULL` predicate is what makes the
   * count exact — a row already stamped reports false and is not re-counted,
   * however many branches reach here.
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
    // An operator halt outranks every promotion reason, including a `draft`
    // or `listed` row. Checked FIRST: the earlier version only looked at it in
    // the frozen/retired branch, so a halted draft was relisted unconditionally.
    if (marketsRepo.isOperatorHalted(this.db, candidate.conditionId)) {
      return "skipped";
    }
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
    // A market row existing is NOT proof it carries a schedule. An admin can
    // create an unscheduled draft (allowed — drafts are inert), and promoting
    // that to listed would publish a market whose config has no embargoSec
    // stamp, so the daemon's expected reveal time disagrees with the chain and
    // every submission to it is rejected. Refuse to promote without the
    // snapshot rather than listing a market that cannot work.
    // Listability is decided HERE, against FRESH time, for every promotion
    // path. The post-receipt check used `opts.nowMs`, captured before
    // estimation/broadcast/receipt-wait, and both recovery branches reached
    // promotion without any window check at all — so a market whose submission
    // window had closed could still be listed while the contract rejected
    // every submission to it.
    const schedule = this.expectedSchedule(candidate.endDateEpochSec, candidate.conditionId);
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
    // A market row existing is NOT proof it has a schedule. An admin can
    // create an unscheduled draft, and previously this returned true for it —
    // so discovery would register that market on-chain and list it with no
    // embargoSec stamp, rejecting every submission to it.
    //
    // Re-run the schedule-aware registration to bind the schedule to the
    // existing row. It is idempotent: the market upsert is a no-op on
    // unchanged fields, the series conflict check is exact, and the clock
    // insert is skipped when a snapshot already exists.
    if (!this.hasExactScheduleSnapshot(candidate)) {
      // A CONFLICTING snapshot is not repairable. Shared registration skips the
      // clock insert whenever any row exists, so re-running it would restamp
      // config, return 201, spend gas on a one-shot registration, and only then
      // fail the post-receipt guard — leaving a frozen market and an
      // irreversible spend. Freeze first instead.
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
      actor: DISCOVERY_ACTOR,
      // Schedule travels WITH the registration so the market, its embargo
      // stamp, its series and its clock snapshot are one atomic write.
      schedule: {
        seriesId: this.seriesId(),
        displayName: `polymarket ${this.config.windowDurationSec}s binary`,
        windowSeconds: this.config.windowDurationSec,
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
   * Verify the runtime clock constants still match the persisted series BEFORE
   * touching any market.
   *
   * The repository-level conflict check is real defense-in-depth, but it only
   * fires when a NEW series row is written. Candidate processing derives the
   * expected on-chain schedule from the current runtime config first, so a
   * changed constant makes every already-registered market look like an
   * on-chain mismatch and bulk-freezes live markets before the repo ever
   * throws. Fail the tick instead, mutating nothing.
   */
  private assertSeriesConfigUnchanged(): void {
    const stored = marketSeriesRepo.get(this.db, this.seriesId());
    if (!stored) return;
    const c = this.config.seriesClock;
    const same =
      stored.submission_open_lead_sec === c.submissionOpenLeadSec &&
      stored.commit_margin_sec === c.commitMarginSec &&
      stored.delivery_budget_sec === c.deliveryBudgetSec &&
      stored.embargo_sec === c.embargoSec &&
      stored.window_seconds === this.config.windowDurationSec;
    // The cohort cap is part of the series contract too: registering the next
    // market would otherwise rewrite it for every existing one.
    if (stored.max_armed_per_call !== this.config.maxArmedPerCall) {
      throw new SeriesCapConflictError(
        this.seriesId(),
        stored.max_armed_per_call,
        this.config.maxArmedPerCall,
      );
    }
    if (!same) {
      throw new SeriesClockConflictError(
        this.seriesId(),
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
   * Whether this market carries an immutable clock snapshot derived from the
   * SAME end date we are about to register. A snapshot from a different end
   * date means the venue moved the market after we froze its schedule; a
   * missing one means the row was created outside the schedule-aware path
   * (e.g. an admin draft) and has no embargo stamp.
   */
  private hasExactScheduleSnapshot(candidate: DiscoveryCandidate): boolean {
    const snap = marketClocksRepo.get(this.db, candidate.conditionId);
    if (!snap) return false;
    // Derived from THIS end date — a snapshot from a moved end date is stale.
    if (snap.derived_from_end_date_ms !== candidate.endDateEpochSec * 1000) return false;

    // The market's config must actually carry the embargo the snapshot
    // implies. An unscheduled re-upsert overwrites config_json while leaving
    // the clock row intact, so an end-date-only check passes a market whose
    // stamp was stripped — and acceptance then derives end + 0 embargo and
    // rejects the chain's embargoed reveal on every submission.
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

    // And the snapshot must belong to a series whose constants still exist.
    // A snapshot bound to a retired/unknown series is not a usable binding.
    return marketSeriesRepo.get(this.db, snap.series_id) !== null;
  }

  /**
   * Series identity. Includes an explicit VERSION so an intentional clock
   * change has a supported path: bump the version and new markets bind to a
   * new series, while existing markets keep the schedule they were registered
   * with. Without it, changing a constant had no legal outcome — the preflight
   * throws every tick and the error's "use a new series id" advice was
   * impossible to follow because the id was derived only from window length.
   */
  private seriesId(): string {
    return `polymarket:binary-${this.config.windowDurationSec}s:v${this.config.seriesVersion}`;
  }

  private async broadcastRegistration(
    candidate: DiscoveryCandidate,
    opts: { nowMs: number; spend: TickSpendState },
  ): Promise<CandidateOutcome> {
    const { conditionId, endDateEpochSec } = candidate;
    const marketId = conditionId as Hex;
    const schedule = this.expectedSchedule(endDateEpochSec, conditionId);
    const now_iso = isoFromMs(this.now().getTime());

    // Spend ceiling per write. A gas spike affects every candidate, so a
    // breach stops the remainder of the tick rather than trying the next.
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

    // A genuinely NEW transaction, so restart the stuck clock. Reaching here
    // after a reverted receipt leaves the row in `broadcasting`; without the
    // reset the replacement would inherit the dead attempt's age and could
    // alert as critical the moment it was sent.
    // Last-moment halt re-check. The entry guard ran before an awaited gas
    // estimate; an operator can halt during it, and registration is a
    // one-shot on-chain write, so proceeding would spend gas permanently
    // registering a market they just pulled. The receipt path stops the
    // relist, but it cannot un-send the transaction.
    if (marketsRepo.isOperatorHalted(this.db, conditionId)) {
      this.recordCandidateError(conditionId, "operator_halted_during_estimate", now_iso);
      return "skipped";
    }
    // ...and again inside the broadcast slot, because the write below can
    // still wait behind another relayer transaction after this point.
    const preBroadcast = () => {
      if (marketsRepo.isOperatorHalted(this.db, conditionId)) {
        throw new Error(`market ${conditionId} halted by operator before broadcast`);
      }
    };
    polymarketDiscoveryRepo.markBroadcasting(this.db, {
      condition_id: conditionId,
      now_iso,
      resetWatermark: true,
    });
    let hash: Hex;
    try {
      hash = await this.registrar.registerMarket(marketId, schedule, { preBroadcast });
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
      // Same schedule-binding invariant as promoteCandidate. This path lists a
      // market directly after its own registration receipt, so without the
      // check it silently bypasses the guard: an existing unscheduled draft
      // (which stageDraft leaves untouched) would be published with no
      // embargoSec stamp and reject every submission to it.
      // `endStillFuture` is not sufficient: a market whose SUBMISSION window
      // has already closed is publicly listed while the contract rejects every
      // submission to it. Require the submission window to still be open.
      // FRESH time. `opts.nowMs` was captured before estimation, broadcast and
      // the receipt wait, so a receipt that crosses the deadline would still
      // list a market the contract now rejects every submission to.
      const submissionStillOpen =
        this.now().getTime() < Number(schedule.submissionCloseAt) * 1000;
      // An operator can freeze a market while this broadcast is in flight —
      // the request returns and audits before the receipt lands. Relisting
      // here would silently undo that halt.
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
        // Receipt landed after the window ended — registered on-chain but
        // never listable. Freeze instead of exposing a dead market.
        //
        // Not when halted: the operator's chosen status stands. Writing
        // `frozen` here would demote a market they deliberately `retired`.
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

  /**
   * The six-instant on-chain schedule for a market instance, derived from its
   * endDate and this series' clock constants.
   *
   * Single source of truth for BOTH the on-chain equality check and the
   * registration write — deriving them separately is exactly how a daemon and
   * a chain drift into disagreeing about when submissions close.
   */
  private expectedSchedule(
    endDateEpochSec: number,
    conditionId?: string,
  ): OnchainSchedule {
    // A market ALREADY BOUND to a schedule must be compared against its own
    // frozen snapshot, never against current global config.
    //
    // Deriving from config meant that bumping the series version (or changing
    // any constant) reinterpreted every live market: its exact, correct
    // on-chain schedule was classified as a mismatch and the market was
    // frozen. That is the precise opposite of what versioning is for —
    // existing markets are supposed to keep the schedule they were registered
    // with, and only NEW markets adopt the new constants.
    const bound = conditionId ? marketClocksRepo.get(this.db, conditionId) : null;
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
      windowSec: this.config.windowDurationSec,
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

  /**
   * Record a terminal freeze decision durably.
   *
   * `markFrozen` is an UPDATE, so with no ledger row it changes nothing. That
   * happens for a market registered on-chain out-of-band: nothing records the
   * decision, the candidate is rediscovered next tick, and it is logged as
   * "newly frozen" forever. Seeding the ledger row first makes the freeze
   * stick, so later ticks skip it.
   */
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
