/**
 * Minimal Polymarket Gamma HTTP client.
 *
 * Surface:
 *   - `fetchMarketByConditionId(conditionId)`: returns a parsed snapshot,
 *     `null` on 404 / final-failure, throws nothing.
 *
 * Behavior baked in per RESEARCH §1, §7, §8:
 *   - LRU caching keyed on conditionId:
 *       · 1h TTL for `closed=true` markets (immutable modulo dispute)
 *       · 60s TTL for active markets
 *       · 5min negative cache for 404s (also for terminal errors)
 *   - Single-flight per conditionId: concurrent requests for the same key
 *     reuse one in-flight promise. Prevents N agents hitting the same
 *     conditionId from amplifying load through the resolver tick.
 *   - 3× exponential backoff (`200ms · 2^n + jitter`) on transient
 *     failures, then fall back to the cached value or `null`.
 *   - Hard 6s per-request timeout via AbortController; the cumulative
 *     budget across 3 retries stays under the resolver tick's 60s window.
 *
 * Condition-lookup decision (per the operator's note on /markets/keyset):
 *   Live curl on 2026-05-12 confirms `/markets/keyset` does NOT accept
 *   a `condition_ids` filter — it's a cursor-paginated list (`limit`,
 *   `next_cursor` only). The deprecated `/markets?condition_ids=…` route
 *   is the only way to pull a single market by conditionId (and still
 *   functions despite the past-sunset header).
 *
 *   Decision: prefer `/markets?condition_ids=…` (option b in the brief)
 *   while it returns 200, with the keyset-index LRU (option a) as a
 *   fallback that the sync ticker maintains opportunistically by reading
 *   pages it would scan anyway. When Polymarket finally turns the
 *   deprecated route off, the keyset-index becomes the primary lookup
 *   path with no adapter-shape change — only the client's lookup helper
 *   flips. That migration is logged in RESEARCH §11 risk 6.
 *
 * Cite: RESEARCH_polymarket_gamma_adapter.md §1, §3, §7, §8.
 */

import type { GammaMarketSnapshot } from "./transform.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 200;
const TTL_RESOLVED_MS = 60 * 60 * 1000; // 1h
const TTL_ACTIVE_MS = 60 * 1000; // 60s
const TTL_NEGATIVE_MS = 5 * 60 * 1000; // 5min
const LRU_CAPACITY = 10_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FetchFnLike {
  (input: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export interface PolymarketGammaTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PolymarketClientOpts {
  /** Override the Gamma base URL (test fixtures point at a stub). */
  baseUrl?: string;
  /** Inject a custom fetch (offline smoke uses this). */
  fetchFn?: FetchFnLike;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Max retry count on transient failure. */
  maxRetries?: number;
  /** Cache TTL clock. */
  nowMs: () => number;
  /** Retry jitter helper. Defaults to 0..199ms random jitter. */
  retryJitterMs?: () => number;
  /** Sleep helper (smoke skips real backoff sleeps). */
  sleepMs?: (ms: number) => Promise<void>;
  /** Timer Adapter for request aborts and default sleeps. */
  timers?: PolymarketGammaTimers;
}

/** Cache entry — `snapshot=null` for negative-cache (404 / final error). */
interface CacheEntry {
  snapshot: GammaMarketSnapshot | null;
  expiresAtMs: number;
}

export interface FetchResult {
  snapshot: GammaMarketSnapshot | null;
  /** Source for the value — useful for the sync-ticker book-keeping. */
  source: "lru" | "fresh" | "negative_cache" | "fallback";
  /** Stable error code on failure paths; null on success. */
  error: string | null;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class PolymarketGammaClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFnLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly nowMs: () => number;
  private readonly retryJitterMs: () => number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly timers: PolymarketGammaTimers;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<FetchResult>>();

  constructor(opts: PolymarketClientOpts) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = opts.fetchFn ?? defaultFetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.nowMs = opts.nowMs;
    this.retryJitterMs =
      opts.retryJitterMs ??
      (() => Math.floor(Math.random() * BASE_BACKOFF_MS));
    this.timers = opts.timers ?? defaultTimers;
    this.sleepMs =
      opts.sleepMs ??
      ((ms) =>
        new Promise<void>((resolve) => {
          this.timers.setTimeout(resolve, ms);
        }));
  }

  /**
   * Resolve a `conditionId` to a snapshot. Honors LRU + single-flight +
   * negative-cache + backoff. NEVER throws.
   */
  async fetchMarketByConditionId(conditionId: string): Promise<FetchResult> {
    const key = conditionId.toLowerCase();
    const now = this.nowMs();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAtMs > now) {
      // Refresh LRU recency by deleting + re-setting.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return {
        snapshot: cached.snapshot,
        source: cached.snapshot === null ? "negative_cache" : "lru",
        error: cached.snapshot === null ? "negative_cache_hit" : null,
      };
    }
    // Coalesce concurrent fetches on the same key.
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await this.fetchAndCache(key, cached);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop a cache entry (smoke / admin tooling). */
  invalidate(conditionId: string): void {
    this.cache.delete(conditionId.toLowerCase());
  }

  /** Test helper — current cache size. */
  cacheSize(): number {
    return this.cache.size;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async fetchAndCache(
    conditionId: string,
    stale: CacheEntry | undefined,
  ): Promise<FetchResult> {
    let lastError: string = "unknown";
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const result = await this.fetchOnce(conditionId);
      if (result.kind === "ok") {
        const ttl = result.snapshot.closed === true
          ? TTL_RESOLVED_MS
          : TTL_ACTIVE_MS;
        this.setCache(conditionId, {
          snapshot: result.snapshot,
          expiresAtMs: this.nowMs() + ttl,
        });
        return { snapshot: result.snapshot, source: "fresh", error: null };
      }
      if (result.kind === "not_found") {
        // 404 — negative cache so a typo'd conditionId can't DDoS the
        // daemon. The sync ticker reads this branch via `error` and
        // increments `consecutive_failures`.
        this.setCache(conditionId, {
          snapshot: null,
          expiresAtMs: this.nowMs() + TTL_NEGATIVE_MS,
        });
        return { snapshot: null, source: "fresh", error: "http_404" };
      }
      // Transient: retry with backoff (200ms · 2^n + jitter), capped at
      // 3 attempts. Errors here are network, 5xx, timeout, or HTML body.
      lastError = result.error;
      if (attempt < this.maxRetries - 1) {
        const jitter = Math.max(0, Math.floor(this.retryJitterMs()));
        await this.sleepMs(BASE_BACKOFF_MS * 2 ** attempt + jitter);
      }
    }
    // All retries exhausted. If we have a still-valid-shape cached entry,
    // surface it tagged as 'fallback'; otherwise null + error.
    if (stale && stale.snapshot !== null) {
      return {
        snapshot: stale.snapshot,
        source: "fallback",
        error: lastError,
      };
    }
    // Negative-cache transient failures so the next 5 minutes' worth of
    // retries don't hammer the same broken URL.
    this.setCache(conditionId, {
      snapshot: null,
      expiresAtMs: this.nowMs() + TTL_NEGATIVE_MS,
    });
    return { snapshot: null, source: "fresh", error: lastError };
  }

  private async fetchOnce(
    conditionId: string,
  ): Promise<
    | { kind: "ok"; snapshot: GammaMarketSnapshot }
    | { kind: "not_found" }
    | { kind: "transient"; error: string }
  > {
    const url = `${this.baseUrl}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`;
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<FetchFnLike>>;
    try {
      response = await this.fetchFn(url, { signal: controller.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: "transient",
        error: msg.includes("abort") ? "timeout" : `network:${msg}`,
      };
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (response.status === 404) return { kind: "not_found" };
    if (response.status < 200 || response.status >= 300) {
      return {
        kind: "transient",
        error: `http_${response.status}`,
      };
    }
    // Defend against the Cloudflare-sunset case: response body is HTML
    // rather than JSON (RESEARCH §8 last row). Caller maps to 'pending'
    // for all markets in that branch.
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      return { kind: "transient", error: "gamma_endpoint_removed" };
    }
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      return {
        kind: "transient",
        error: `read_body:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      return {
        kind: "transient",
        error: `json_parse:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Gamma's /markets returns an array (even with limit=1 + a filter).
    // Empty array means "no row matches this conditionId" — treat as 404
    // semantically so the negative-cache + alert paths fire correctly.
    const candidates = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { markets?: unknown }).markets)
        ? ((parsed as { markets: unknown[] }).markets as unknown[])
        : null;
    if (candidates === null) {
      return { kind: "transient", error: "schema_drift:envelope" };
    }
    if (candidates.length === 0) return { kind: "not_found" };
    const snapshots = candidates.filter(
      (candidate): candidate is GammaMarketSnapshot =>
        candidate !== null &&
        typeof candidate === "object" &&
        typeof (candidate as { conditionId?: unknown }).conditionId === "string",
    );
    if (snapshots.length === 0) {
      return { kind: "transient", error: "schema_drift:missing_conditionId" };
    }
    // Never trust the server-side filter or response ordering. Accepting a
    // different condition here would turn an unrelated market result into a
    // terminal verdict and corrupt scoring.
    const snapshot = snapshots.find(
      (candidate) => candidate.conditionId.toLowerCase() === conditionId,
    );
    if (!snapshot) {
      return { kind: "transient", error: "schema_drift:condition_id_mismatch" };
    }
    return { kind: "ok", snapshot: snapshot as GammaMarketSnapshot };
  }

  private setCache(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, entry);
    // Evict LRU head when over capacity.
    while (this.cache.size > LRU_CAPACITY) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

// ─── Default fetch (delegates to globalThis.fetch when available) ──────────

const defaultFetch: FetchFnLike = async (input, init) => {
  // Node ≥18 provides globalThis.fetch; older runtimes are unsupported.
  const gf = (globalThis as { fetch?: unknown }).fetch;
  if (typeof gf !== "function") {
    throw new Error("polymarket-gamma: globalThis.fetch is not available");
  }
  const res = (await (gf as (
    input: string,
    init?: { signal?: AbortSignal },
  ) => Promise<Response>)(input, init)) as unknown as {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  };
  return res;
};

const defaultTimers: PolymarketGammaTimers = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
