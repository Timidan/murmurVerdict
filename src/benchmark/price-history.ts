// In-process price-history ring buffer for the benchmark baselines.
//
// Wave 4c-A — the three baseline agents (Murmur Momentum, Contrarian,
// Risk-Off) decide off short windows of recent oracle prices. Persisting
// those samples to SQLite would buy us nothing: baselines self-bootstrap
// after a daemon restart from new oracle ticks, and a few hours of cold-
// start silence is acceptable. Keeping the buffer in-process also keeps
// the ticker hot path free of any DB I/O beyond the submitCall write.
//
// Eviction is by elapsed time, not by sample count: the longest lookback
// any baseline performs is Contrarian's 24h fade, so retaining ~25h of
// samples is sufficient regardless of BENCHMARK_TICK_SEC. (A fixed-count
// buffer would silently break Contrarian when operators run sub-default
// cadences — e.g. 60s ticks would only retain ~2.4h.)

export interface PriceSample {
  /** Decimal string price as returned by OracleObservation.price. */
  price: string;
  /** Oracle feed_timestamp (ISO8601 UTC). Authoritative for age math. */
  ts: string;
}

export interface PriceLookup {
  /** Sample whose age is closest to target_age_hours. */
  sample: PriceSample;
  /** Actual age in hours from `now` to sample.ts. */
  actual_age_hours: number;
}

const DEFAULT_RETAIN_MS = 25 * 60 * 60 * 1000; // 25h; covers Contrarian's 24h horizon plus margin

export class PriceHistory {
  private readonly buffers = new Map<string, PriceSample[]>();
  private readonly retainMs: number;

  constructor(retainMs: number = DEFAULT_RETAIN_MS) {
    if (retainMs <= 0) {
      throw new Error(`PriceHistory retainMs must be positive, got ${retainMs}`);
    }
    this.retainMs = retainMs;
  }

  /**
   * Append a fresh price sample for `asset_id`. Anything older than
   * `retainMs` from the just-recorded sample's timestamp is evicted —
   * anchoring on the oracle clock (not wall-clock) keeps the buffer
   * stable across small clock drifts and predictable in tests.
   */
  record(asset_id: string, price: string, ts: string): void {
    let buf = this.buffers.get(asset_id);
    if (!buf) {
      buf = [];
      this.buffers.set(asset_id, buf);
    }
    buf.push({ price, ts });
    const cutoffMs = Date.parse(ts) - this.retainMs;
    while (buf.length > 0 && Date.parse(buf[0]!.ts) < cutoffMs) {
      buf.shift();
    }
  }

  /**
   * Return the per-asset buffer in append order (oldest → newest).
   * Returns an empty array when the asset has not been recorded yet.
   * Caller must not mutate the returned array.
   */
  samples(asset_id: string): readonly PriceSample[] {
    return this.buffers.get(asset_id) ?? [];
  }

  /**
   * Locate the sample whose age (relative to `now`) is closest to
   * `target_age_hours`, provided that age falls within
   * `[target_age_hours − tolerance_hours, target_age_hours + tolerance_hours]`.
   * Returns null when the buffer has no qualifying sample (cold start).
   */
  lookup(
    asset_id: string,
    target_age_hours: number,
    tolerance_hours: number,
    now: Date = new Date(),
  ): PriceLookup | null {
    const buf = this.buffers.get(asset_id);
    if (!buf || buf.length === 0) return null;
    const minAge = Math.max(0, target_age_hours - tolerance_hours);
    const maxAge = target_age_hours + tolerance_hours;
    const nowMs = now.getTime();
    let best: PriceLookup | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const s of buf) {
      const ageHours = (nowMs - Date.parse(s.ts)) / 3_600_000;
      if (ageHours < minAge || ageHours > maxAge) continue;
      const delta = Math.abs(ageHours - target_age_hours);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = { sample: s, actual_age_hours: ageHours };
      }
    }
    return best;
  }
}

// ─── Signal helpers ──────────────────────────────────────────────────────────
//
// Pure functions over PriceSample[] / numbers so the agent decision logic in
// agents.ts stays declarative and unit-testable in isolation.

/**
 * Percentage change from `oldPrice` to `newPrice`, expressed as a decimal
 * (e.g. +0.005 == +0.5%). Returns null on parse failure or non-positive
 * old price (would blow up the divisor).
 */
export function pctChange(oldPrice: string, newPrice: string): number | null {
  const o = Number(oldPrice);
  const n = Number(newPrice);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o <= 0) return null;
  return (n - o) / o;
}

/**
 * Stdev of consecutive log-returns across the trailing window (in hours).
 * Returns null when fewer than `minSamples` samples fall inside the window
 * (cold start — caller decides what to do, typically skip).
 */
export function realizedVol(
  samples: readonly PriceSample[],
  windowHours: number,
  minSamples: number,
  now: Date = new Date(),
): number | null {
  const cutoffMs = now.getTime() - windowHours * 3_600_000;
  const inWindow: PriceSample[] = [];
  for (const s of samples) {
    if (Date.parse(s.ts) >= cutoffMs) inWindow.push(s);
  }
  if (inWindow.length < minSamples) return null;
  const returns: number[] = [];
  for (let i = 1; i < inWindow.length; i++) {
    const prev = Number(inWindow[i - 1]!.price);
    const cur = Number(inWindow[i]!.price);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push(Math.log(cur / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}
