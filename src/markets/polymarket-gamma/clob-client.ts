/**
 * Minimal Polymarket CLOB HTTP client — the post-disappearance fallback
 * surface for `observeResolution` and the sync ticker.
 *
 * Gamma drops 5-minute micro-markets minutes after close (`/markets?
 * condition_ids=…` returns `200 []`), but the public, key-less
 * `GET clob.polymarket.com/markets/{conditionId}` keeps serving them with
 * `closed` + per-token `winner` flags. This client exists ONLY for that
 * fallback read — Gamma stays the primary surface (richer UMA status).
 *
 * Budget posture (tighter than the Gamma client on purpose — the resolver
 * walks pending calls sequentially, so a CLOB outage must not consume the
 * tick):
 *   - 2s per-request timeout, 1 retry (2 attempts total).
 *   - LRU caching keyed on conditionId:
 *       · 1h TTL once `closed=true` with exactly one winner (terminal)
 *       · 45s TTL for present-but-pending markets
 *       · 45s negative cache for 404s / final errors
 *   - Single-flight per conditionId.
 *   - Process-wide circuit breaker on transport failures (network, timeout,
 *     429, 5xx): after 5 consecutive transport failures the breaker opens
 *     for 60s and every fetch short-circuits to `circuit_open` without a
 *     network call. Any success / 404 closes it.
 *
 * NEVER throws — same no-throw result contract as the Gamma client.
 */

import { z } from "zod";
import type { FetchFnLike, PolymarketGammaTimers } from "./client.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RETRIES = 2; // 1 retry
const BASE_BACKOFF_MS = 200;
const TTL_TERMINAL_MS = 60 * 60 * 1000; // 1h — closed + one winner
const TTL_PENDING_MS = 45 * 1000; // present but not yet sealed
const TTL_NEGATIVE_MS = 45 * 1000; // 404 / exhausted retries
const LRU_CAPACITY = 10_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_OPEN_MS = 60 * 1000;

// ─── Schema (passthrough — CLOB adds fields without notice) ─────────────────

export const clobTokenSchema = z
  .object({
    token_id: z.string().min(1),
    outcome: z.string(),
    price: z.number(),
    winner: z.boolean(),
  })
  .passthrough();

export const clobMarketSnapshotSchema = z
  .object({
    condition_id: z.string().min(1),
    question: z.string().optional(),
    closed: z.boolean(),
    archived: z.boolean().optional(),
    accepting_orders: z.boolean().optional(),
    end_date_iso: z.string().nullable().optional(),
    is_50_50_outcome: z.boolean().optional(),
    tokens: z.array(clobTokenSchema).length(2),
  })
  .passthrough();

export type ClobMarketSnapshot = z.infer<typeof clobMarketSnapshotSchema>;
export type ClobToken = z.infer<typeof clobTokenSchema>;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PolymarketClobClientOpts {
  /** Override the CLOB base URL (smoke fixtures point at a stub). */
  baseUrl?: string;
  /** Inject a custom fetch (offline smoke uses this). */
  fetchFn?: FetchFnLike;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Max attempt count (retries = maxRetries - 1). */
  maxRetries?: number;
  /** Cache TTL + breaker clock. */
  nowMs: () => number;
  /** Retry jitter helper. Defaults to 0..199ms random jitter. */
  retryJitterMs?: () => number;
  /** Sleep helper (smoke skips real backoff sleeps). */
  sleepMs?: (ms: number) => Promise<void>;
  /** Timer adapter for request aborts and default sleeps. */
  timers?: PolymarketGammaTimers;
}

/** Cache entry — `snapshot=null` for negative-cache (404 / final error). */
interface ClobCacheEntry {
  snapshot: ClobMarketSnapshot | null;
  expiresAtMs: number;
}

export interface ClobFetchResult {
  snapshot: ClobMarketSnapshot | null;
  source: "lru" | "fresh" | "negative_cache" | "circuit_open";
  /** Stable error code on failure paths; null on success. */
  error: string | null;
}

// ─── Implementation ─────────────────────────────────────────────────────────

export class PolymarketClobClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFnLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly nowMs: () => number;
  private readonly retryJitterMs: () => number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly timers: PolymarketGammaTimers;

  private readonly cache = new Map<string, ClobCacheEntry>();
  private readonly inflight = new Map<string, Promise<ClobFetchResult>>();
  private breakerFailures = 0;
  private breakerOpenUntilMs = 0;

  constructor(opts: PolymarketClobClientOpts) {
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
   * Resolve a `conditionId` to a CLOB snapshot. Honors LRU + single-flight +
   * negative-cache + circuit breaker + backoff. NEVER throws.
   */
  async fetchMarketByConditionId(conditionId: string): Promise<ClobFetchResult> {
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
    if (this.breakerOpenUntilMs > now) {
      // Circuit open — the CLOB surface is down; don't burn the resolver
      // tick on more sequential timeouts. Not negative-cached: the breaker
      // is process-wide and self-expiring.
      return { snapshot: null, source: "circuit_open", error: "circuit_open" };
    }
    // Coalesce concurrent fetches on the same key.
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await this.fetchAndCache(key);
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

  private async fetchAndCache(conditionId: string): Promise<ClobFetchResult> {
    let lastError: string = "unknown";
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const result = await this.fetchOnce(conditionId);
      if (result.kind === "ok") {
        this.noteBreakerSuccess();
        const terminal =
          result.snapshot.closed === true &&
          result.snapshot.tokens.filter((t) => t.winner === true).length === 1;
        this.setCache(conditionId, {
          snapshot: result.snapshot,
          expiresAtMs: this.nowMs() + (terminal ? TTL_TERMINAL_MS : TTL_PENDING_MS),
        });
        return { snapshot: result.snapshot, source: "fresh", error: null };
      }
      if (result.kind === "not_found") {
        // A 404 is a healthy response from the service — reset the breaker.
        this.noteBreakerSuccess();
        this.setCache(conditionId, {
          snapshot: null,
          expiresAtMs: this.nowMs() + TTL_NEGATIVE_MS,
        });
        return { snapshot: null, source: "fresh", error: "http_404" };
      }
      if (result.kind === "transport") this.noteBreakerFailure();
      lastError = result.error;
      // If that failure just opened the breaker, the surface is down — skip
      // the remaining retry budget instead of burning ~2s more on it.
      if (this.breakerOpenUntilMs > this.nowMs()) break;
      if (attempt < this.maxRetries - 1) {
        const jitter = Math.max(0, Math.floor(this.retryJitterMs()));
        await this.sleepMs(BASE_BACKOFF_MS * 2 ** attempt + jitter);
      }
    }
    // Retries exhausted — negative-cache so the next tick's pending walk
    // doesn't re-hammer the same broken conditionId.
    this.setCache(conditionId, {
      snapshot: null,
      expiresAtMs: this.nowMs() + TTL_NEGATIVE_MS,
    });
    return { snapshot: null, source: "fresh", error: lastError };
  }

  private async fetchOnce(
    conditionId: string,
  ): Promise<
    | { kind: "ok"; snapshot: ClobMarketSnapshot }
    | { kind: "not_found" }
    | { kind: "transport"; error: string }
    | { kind: "drift"; error: string }
  > {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(conditionId)}`;
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Awaited<ReturnType<FetchFnLike>>;
    try {
      response = await this.fetchFn(url, { signal: controller.signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: "transport",
        error: msg.includes("abort") ? "timeout" : `network:${msg}`,
      };
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (response.status === 404) return { kind: "not_found" };
    if (response.status === 429 || response.status >= 500) {
      return { kind: "transport", error: `http_${response.status}` };
    }
    if (response.status < 200 || response.status >= 300) {
      return { kind: "drift", error: `http_${response.status}` };
    }
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      return {
        kind: "transport",
        error: `read_body:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      return {
        kind: "drift",
        error: `json_parse:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const validated = clobMarketSnapshotSchema.safeParse(parsed);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      const where = issue ? issue.path.join(".") || issue.code : "unknown";
      return { kind: "drift", error: `schema_drift:${where}` };
    }
    // Never trust the URL routing alone — accepting a different condition
    // would turn an unrelated market into a terminal verdict.
    if (validated.data.condition_id.toLowerCase() !== conditionId) {
      return { kind: "drift", error: "schema_drift:condition_id_mismatch" };
    }
    return { kind: "ok", snapshot: validated.data };
  }

  private noteBreakerFailure(): void {
    this.breakerFailures += 1;
    if (this.breakerFailures >= BREAKER_THRESHOLD) {
      this.breakerOpenUntilMs = this.nowMs() + BREAKER_OPEN_MS;
    }
  }

  private noteBreakerSuccess(): void {
    this.breakerFailures = 0;
    this.breakerOpenUntilMs = 0;
  }

  private setCache(key: string, entry: ClobCacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > LRU_CAPACITY) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

// ─── Default fetch / timers (mirrors client.ts) ─────────────────────────────

const defaultFetch: FetchFnLike = async (input, init) => {
  const gf = (globalThis as { fetch?: unknown }).fetch;
  if (typeof gf !== "function") {
    throw new Error("polymarket-clob: globalThis.fetch is not available");
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
