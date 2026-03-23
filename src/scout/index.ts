import * as dotenv from "dotenv";
dotenv.config();

import {
  ASSET_UNIVERSE,
  type AssetSlug,
  type AssetRawSignals,
  type RawSignal,
  type SantimentMetric,
  type TimeseriesPoint,
  ScoutError,
} from "../types/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SANTIMENT_API_URL = "https://api.santiment.net/graphql";

const ALL_METRICS: SantimentMetric[] = [
  "social_dominance_total",
  "sentiment_weighted_total",
  "exchange_inflow_usd",
  "exchange_outflow_usd",
  "age_consumed",
  "daily_active_addresses",
  "network_growth",
  "mvrv_usd",
  "whale_transaction_count_100k_usd_to_inf",
];

// Some metrics are only meaningful for certain assets —
// filter out if Santiment returns null / empty
const METRIC_LABELS: Record<SantimentMetric, string> = {
  social_dominance_total: "Social Dominance",
  sentiment_weighted_total: "Weighted Sentiment",
  exchange_inflow_usd: "Exchange Inflow (USD)",
  exchange_outflow_usd: "Exchange Outflow (USD)",
  age_consumed: "Age Consumed (Dormant Circulation)",
  daily_active_addresses: "Daily Active Addresses",
  network_growth: "Network Growth",
  mvrv_usd: "MVRV (USD)",
  whale_transaction_count_100k_usd_to_inf: "Whale Tx Count (>$100k)",
};

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ─── HTTP / GraphQL client ────────────────────────────────────────────────────

async function santimentQuery<T>(
  query: string,
  apiKey: string,
  variables?: Record<string, unknown>,
  retries = MAX_RETRIES
): Promise<T> {
  const lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(SANTIMENT_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Apikey ${apiKey}`,
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });

      if (!res.ok) {
        throw new ScoutError(`HTTP ${res.status}: ${res.statusText}`, {
          attempt,
          query: query.slice(0, 120),
        });
      }

      const json = (await res.json()) as { data?: T; errors?: { message: string }[] };

      if (json.errors && json.errors.length > 0) {
        const messages = json.errors.map((e) => e.message).join("; ");
        throw new ScoutError(`GraphQL errors: ${messages}`, {
          attempt,
          query: query.slice(0, 120),
        });
      }

      if (!json.data) {
        throw new ScoutError("No data returned from Santiment", { attempt });
      }

      return json.data;
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      const delay = RETRY_DELAY_MS * attempt;
      console.warn(
        `[Scout] Attempt ${attempt}/${retries} failed — retrying in ${delay}ms: ${(err as Error).message}`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function toISO(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

export function hoursAgo(n: number): Date {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d;
}

// ─── Single metric fetch ──────────────────────────────────────────────────────

/**
 * Fetch a single Santiment metric for a single asset over a date range.
 */
export async function fetchMetric(params: {
  apiKey: string;
  metric: SantimentMetric;
  slug: AssetSlug;
  from: Date;
  to: Date;
  interval?: string;
}): Promise<TimeseriesPoint[]> {
  const { apiKey, metric, slug, from, to, interval = "1d" } = params;

  const query = `query($metric: String!, $slug: String!, $from: DateTime!, $to: DateTime!, $interval: interval!) {
    getMetric(metric: $metric) {
      timeseriesData(slug: $slug, from: $from, to: $to, interval: $interval) {
        datetime
        value
      }
    }
  }`;

  type Response = {
    getMetric: { timeseriesData: { datetime: string; value: number }[] } | null;
  };

  const data = await santimentQuery<Response>(query, apiKey, {
    metric,
    slug,
    from: toISO(from),
    to: toISO(to),
    interval,
  });

  if (!data.getMetric) {
    return [];
  }

  return data.getMetric.timeseriesData.filter(
    (p) => p.value !== null && p.value !== undefined && !Number.isNaN(p.value)
  );
}

// ─── Batch metric fetch for one asset ────────────────────────────────────────

/**
 * Fetch ALL metrics for a single asset in one batched GraphQL query.
 * Santiment supports aliased multi-metric queries.
 */
export async function fetchAllMetricsForAsset(params: {
  apiKey: string;
  slug: AssetSlug;
  from: Date;
  to: Date;
  interval?: string;
  metrics?: SantimentMetric[];
}): Promise<Partial<Record<SantimentMetric, TimeseriesPoint[]>>> {
  const { apiKey, slug, from, to, interval = "1d", metrics = ALL_METRICS } = params;

  // Build a batched query with one alias per metric
  // Metric names come from hardcoded ALL_METRICS enum, so interpolating them is safe.
  // Slug/from/to/interval are parameterized via GraphQL variables.
  const aliases = metrics.map((metric, i) => {
    const alias = `m${i}`;
    return `
      ${alias}: getMetric(metric: "${metric}") {
        timeseriesData(
          slug: $slug
          from: $from
          to: $to
          interval: $interval
        ) {
          datetime
          value
        }
      }`;
  });

  const query = `query($slug: String!, $from: DateTime!, $to: DateTime!, $interval: interval!) { ${aliases.join("\n")} }`;

  const queryVariables = {
    slug,
    from: toISO(from),
    to: toISO(to),
    interval,
  };

  type AliasedResponse = Record<
    string,
    { timeseriesData: { datetime: string; value: number }[] } | null
  >;

  let data: AliasedResponse;
  try {
    data = await santimentQuery<AliasedResponse>(query, apiKey, queryVariables);
  } catch (err) {
    console.error(`[Scout] Batch fetch failed for ${slug}:`, (err as Error).message);
    // Fall back to individual fetches
    return fetchMetricsFallback({ apiKey, slug, from, to, interval, metrics });
  }

  const result: Partial<Record<SantimentMetric, TimeseriesPoint[]>> = {};

  metrics.forEach((metric, i) => {
    const alias = `m${i}`;
    const raw = data[alias];
    if (raw && Array.isArray(raw.timeseriesData)) {
      result[metric] = raw.timeseriesData.filter(
        (p) => p.value !== null && p.value !== undefined && !Number.isNaN(p.value)
      );
    } else {
      result[metric] = [];
    }
  });

  return result;
}

/**
 * Fallback: fetch metrics one by one if the batched query fails.
 */
async function fetchMetricsFallback(params: {
  apiKey: string;
  slug: AssetSlug;
  from: Date;
  to: Date;
  interval: string;
  metrics: SantimentMetric[];
}): Promise<Partial<Record<SantimentMetric, TimeseriesPoint[]>>> {
  const { apiKey, slug, from, to, interval, metrics } = params;
  const result: Partial<Record<SantimentMetric, TimeseriesPoint[]>> = {};

  for (const metric of metrics) {
    try {
      result[metric] = await fetchMetric({ apiKey, metric, slug, from, to, interval });
    } catch (err) {
      console.warn(
        `[Scout] Failed to fetch ${metric} for ${slug}: ${(err as Error).message}`
      );
      result[metric] = [];
    }
    // Small delay between individual calls to avoid rate limits
    await sleep(200);
  }

  return result;
}

// ─── Full universe fetch ──────────────────────────────────────────────────────

/**
 * Fetch all metrics for all assets in the universe.
 * Returns a map of slug -> AssetRawSignals.
 */
export async function fetchUniverse(params: {
  apiKey: string;
  windowDays?: number;
  interval?: string;
  metrics?: SantimentMetric[];
  assets?: AssetSlug[];
}): Promise<Map<AssetSlug, AssetRawSignals>> {
  const {
    apiKey,
    windowDays = 30,
    interval = "1d",
    metrics = ALL_METRICS,
    assets = [...ASSET_UNIVERSE],
  } = params;

  const from = daysAgo(windowDays);
  const to = new Date();
  const fetchedAt = new Date().toISOString();

  console.log(
    `[Scout] Fetching ${metrics.length} metrics for ${assets.length} assets over ${windowDays}d window...`
  );

  const results = new Map<AssetSlug, AssetRawSignals>();

  // Fetch assets concurrently with a concurrency cap of 3 to avoid rate-limits
  const CONCURRENCY = 3;
  for (let i = 0; i < assets.length; i += CONCURRENCY) {
    const batch = assets.slice(i, i + CONCURRENCY);

    const settled = await Promise.allSettled(
      batch.map((slug) =>
        fetchAllMetricsForAsset({ apiKey, slug, from, to, interval, metrics })
      )
    );

    settled.forEach((result, idx) => {
      const slug = batch[idx]!;
      if (result.status === "fulfilled") {
        const signals = result.value;
        const nonEmptyCount = Object.values(signals).filter(
          (v) => v && v.length > 0
        ).length;

        results.set(slug, {
          slug,
          signals,
          fetchedAt,
        });

        console.log(
          `[Scout] ✓ ${slug}: ${nonEmptyCount}/${metrics.length} metrics have data`
        );
      } else {
        console.error(`[Scout] ✗ ${slug}: ${result.reason}`);
        // Still add an empty entry so the loop can continue
        results.set(slug, {
          slug,
          signals: {},
          fetchedAt,
        });
      }
    });

    // Brief pause between batches
    if (i + CONCURRENCY < assets.length) {
      await sleep(500);
    }
  }

  console.log(`[Scout] Universe fetch complete: ${results.size}/${assets.length} assets`);
  return results;
}

// ─── Recent signals (for live loop — last 2 days at 1h resolution) ─────────────

/**
 * Fetch the most recent signal readings at higher resolution for the live loop.
 * Uses 1h interval over last 48h for rate-of-change calculations.
 */
export async function fetchRecentSignals(params: {
  apiKey: string;
  slug: AssetSlug;
  hoursBack?: number;
  metrics?: SantimentMetric[];
}): Promise<Partial<Record<SantimentMetric, TimeseriesPoint[]>>> {
  const {
    apiKey,
    slug,
    hoursBack = 48,
    metrics = ALL_METRICS,
  } = params;

  const from = hoursAgo(hoursBack);
  const to = new Date();

  return fetchAllMetricsForAsset({
    apiKey,
    slug,
    from,
    to,
    interval: "1h",
    metrics,
  });
}

// ─── Signal summary (for logging/debugging) ───────────────────────────────────

export function summarizeSignals(assetSignals: AssetRawSignals): string {
  const lines: string[] = [`\n[Scout] Signal Summary — ${assetSignals.slug}`];
  lines.push(`  Fetched at: ${assetSignals.fetchedAt}`);

  for (const [metricKey, points] of Object.entries(assetSignals.signals)) {
    const metric = metricKey as SantimentMetric;
    const label = METRIC_LABELS[metric] ?? metric;

    if (!points || points.length === 0) {
      lines.push(`  ${label}: no data`);
      continue;
    }

    const latest = points[points.length - 1]!;
    const prev = points[points.length - 2];
    const change =
      prev && prev.value !== 0
        ? (((latest.value - prev.value) / Math.abs(prev.value)) * 100).toFixed(2)
        : null;

    lines.push(
      `  ${label}: ${latest.value.toFixed(4)} (${latest.datetime})${change !== null ? `  Δ ${change}%` : ""}`
    );
  }

  return lines.join("\n");
}

// ─── Validate API key ─────────────────────────────────────────────────────────

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    type AuthResponse = { currentUser: { id: string; email: string } | null };
    const data = await santimentQuery<AuthResponse>(
      "{ currentUser { id email } }",
      apiKey
    );
    if (data.currentUser) {
      console.log(
        `[Scout] API key valid — authenticated as: ${data.currentUser.email}`
      );
      return true;
    }
    return false;
  } catch {
    console.error("[Scout] API key validation failed");
    return false;
  }
}

// ─── Asset metadata ───────────────────────────────────────────────────────────

/**
 * Fetch basic project info for our universe to confirm slugs are resolvable.
 */
export async function fetchAssetMetadata(
  apiKey: string,
  slugs: AssetSlug[] = [...ASSET_UNIVERSE]
): Promise<Map<AssetSlug, { name: string; ticker: string; infrastructure: string }>> {
  const aliases = slugs.map(
    (slug, i) => `
      p${i}: projectBySlug(slug: "${slug}") {
        name
        ticker
        infrastructure
      }`
  );

  const query = `{ ${aliases.join("\n")} }`;

  type MetaResponse = Record<
    string,
    { name: string; ticker: string; infrastructure: string } | null
  >;

  const data = await santimentQuery<MetaResponse>(query, apiKey);
  const result = new Map<
    AssetSlug,
    { name: string; ticker: string; infrastructure: string }
  >();

  slugs.forEach((slug, i) => {
    const key = `p${i}`;
    const meta = data[key];
    if (meta) {
      result.set(slug, meta);
    }
  });

  return result;
}

// ─── Standalone runner (npm run scout) ───────────────────────────────────────

async function main() {
  const apiKey = process.env.SANTIMENT_API_KEY;
  if (!apiKey) {
    throw new ScoutError("SANTIMENT_API_KEY is not set in environment");
  }

  console.log("=".repeat(60));
  console.log("  MURMUR — Scout Module");
  console.log("=".repeat(60));

  // 1. Validate key
  const valid = await validateApiKey(apiKey);
  if (!valid) {
    throw new ScoutError("Invalid Santiment API key");
  }

  // 2. Fetch asset metadata
  console.log("\n[Scout] Fetching asset metadata...");
  const metadata = await fetchAssetMetadata(apiKey);
  for (const [slug, meta] of metadata) {
    console.log(`  ${slug}: ${meta.name} (${meta.ticker}) on ${meta.infrastructure}`);
  }

  // 3. Fetch full universe — 30d daily window
  console.log("\n[Scout] Fetching 30d signal window...");
  const universe = await fetchUniverse({ apiKey, windowDays: 30, interval: "1d" });

  // 4. Print summaries
  for (const [, assetSignals] of universe) {
    console.log(summarizeSignals(assetSignals));
  }

  console.log("\n[Scout] Done.");
}

// Run if invoked directly
if (process.argv[1]?.includes("scout")) {
  main().catch((err) => {
    console.error("[Scout] Fatal:", err);
    process.exit(1);
  });
}
