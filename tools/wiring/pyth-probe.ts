// tools/wiring/pyth-probe.ts
//
// Standalone Pyth Hermes probe for Murmur Verdict.
//
// Validates the four seeded Pyth feeds (migration 008) by:
//   1. Per-feed single-ID GET against Hermes /v2/updates/price/latest
//      (parsed=true), extracting price * 10^expo, conf bps, publish_time,
//      prev_publish_time, staleness.
//   2. One batched multi-ID GET (`?ids[]=...&ids[]=...`) to confirm Hermes
//      can return all 4 in a single round-trip.
//   3. Latency benchmark: 5 sequential calls to the batched endpoint,
//      reporting p50/p95/max.
//   4. Smoke-runs the resolver-side adapter from src/integrations/oracles/
//      pyth-pull.ts against synthetic OracleRow records (one per asset)
//      to prove the live wiring matches what the resolver will see.
//
// Exit code: 0 if all 4 feeds parsed with valid (positive, sane) prices and
// the adapter smoke succeeded for all 4. 1 otherwise.
//
// Run:
//   npx tsx tools/wiring/pyth-probe.ts

import { pythPullAdapter } from "../../src/integrations/oracles/pyth-pull.js";
import type { AssetRow, OracleRow } from "../../src/verdict/db.js";

interface SeededFeed {
  oracle_id: string;
  asset_id: string;
  expectedAsset: "ETH" | "BTC" | "SOL" | "BNB";
  price_id: string;
  /** Min/max sanity range used to flag wildly off prices. */
  sanity: { min: number; max: number };
}

const SEEDED: ReadonlyArray<SeededFeed> = [
  {
    oracle_id: "pyth-base-eth-usd",
    asset_id: "eth-usd",
    expectedAsset: "ETH",
    price_id:
      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    sanity: { min: 100, max: 100_000 },
  },
  {
    oracle_id: "pyth-base-btc-usd",
    asset_id: "btc-usd",
    expectedAsset: "BTC",
    price_id:
      "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    sanity: { min: 1_000, max: 1_000_000 },
  },
  {
    oracle_id: "pyth-base-sol-usd",
    asset_id: "sol-usd",
    expectedAsset: "SOL",
    price_id:
      "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    sanity: { min: 1, max: 10_000 },
  },
  {
    oracle_id: "pyth-base-bnb-usd",
    asset_id: "bnb-usd",
    expectedAsset: "BNB",
    price_id:
      "0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
    sanity: { min: 10, max: 10_000 },
  },
] as const;

const HERMES_ENDPOINT =
  process.env.PYTH_HERMES_ENDPOINT ??
  "https://hermes.pyth.network/v2/updates/price/latest";

interface HermesPriceEntry {
  price: string;
  expo: number;
  conf: string;
  publish_time?: number;
}
interface HermesParsedItem {
  id: string;
  price: HermesPriceEntry;
  ema_price?: HermesPriceEntry;
  metadata?: {
    slot?: number;
    publish_time?: number;
    prev_publish_time?: number;
  };
}
interface HermesResponse {
  parsed?: HermesParsedItem[];
  binary?: { encoding: string; data: string[] };
}

interface FeedReport {
  oracle_id: string;
  expectedAsset: string;
  shortId: string;
  fullId: string;
  ok: boolean;
  error?: string;
  price?: number;
  priceStr?: string;
  confBps?: number;
  publishTime?: number;
  prevPublishTime?: number;
  staleness?: number;
  assetMatch: boolean;
  sanityOk: boolean;
  returnedId?: string;
}

function fmtId(id: string): string {
  const noPrefix = id.startsWith("0x") ? id.slice(2) : id;
  return `${noPrefix.slice(0, 6)}…${noPrefix.slice(-4)}`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function fmtNumber(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Single Hermes fetch with one retry on 429/503. */
async function hermesFetch(
  ids: ReadonlyArray<string>,
  timeoutMs = 8_000,
): Promise<HermesResponse> {
  const qs = ids
    .map((id) => `ids[]=${encodeURIComponent(id)}`)
    .join("&");
  const url = `${HERMES_ENDPOINT}?${qs}&parsed=true`;

  const attempt = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt();
  if (res.status === 429 || res.status === 503) {
    await new Promise((r) => setTimeout(r, 600));
    res = await attempt();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`hermes HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as HermesResponse;
}

function pythPriceToNumber(priceStr: string, expo: number): number {
  // expo is typically negative (e.g. -8). priceStr is integer.
  // Use Number for display; bigint for precision-critical paths happens in
  // the adapter, not here.
  const n = Number(priceStr);
  if (!Number.isFinite(n)) return NaN;
  return n * Math.pow(10, expo);
}

function probeOne(
  feed: SeededFeed,
  item: HermesParsedItem | undefined,
  nowSec: number,
): FeedReport {
  const r: FeedReport = {
    oracle_id: feed.oracle_id,
    expectedAsset: feed.expectedAsset,
    shortId: fmtId(feed.price_id),
    fullId: feed.price_id,
    ok: false,
    assetMatch: false,
    sanityOk: false,
  };
  if (!item) {
    r.error = "no parsed entry returned";
    return r;
  }
  // Hermes returns ids without the 0x prefix; normalize for compare.
  const want = feed.price_id.startsWith("0x")
    ? feed.price_id.slice(2).toLowerCase()
    : feed.price_id.toLowerCase();
  const got = item.id?.startsWith("0x")
    ? item.id.slice(2).toLowerCase()
    : (item.id ?? "").toLowerCase();
  r.returnedId = item.id;
  r.assetMatch = got === want;

  const px = item.price;
  if (!px || typeof px.price !== "string" || typeof px.expo !== "number") {
    r.error = "missing price/expo";
    return r;
  }
  const priceNum = pythPriceToNumber(px.price, px.expo);
  r.price = priceNum;
  r.priceStr = formatPythDecimal(BigInt(px.price), px.expo);

  // conf bps: (conf / price) * 10000 — both scaled identically by 10^expo,
  // so the ratio is just conf / priceMantissa.
  if (typeof px.conf === "string") {
    const confBig = BigInt(px.conf);
    const priceBig = BigInt(px.price);
    if (priceBig > 0n) {
      // bps with one extra digit of precision via Number cast on small ratio.
      const ratio = Number(confBig) / Number(priceBig);
      r.confBps = ratio * 10_000;
    }
  }

  const publish = px.publish_time ?? item.metadata?.publish_time;
  if (typeof publish === "number") {
    r.publishTime = publish;
    r.staleness = Math.max(0, nowSec - publish);
  }
  r.prevPublishTime = item.metadata?.prev_publish_time;

  r.sanityOk =
    Number.isFinite(priceNum) &&
    priceNum >= feed.sanity.min &&
    priceNum <= feed.sanity.max;

  r.ok =
    r.assetMatch &&
    r.sanityOk &&
    typeof r.publishTime === "number" &&
    Number.isFinite(priceNum) &&
    priceNum > 0;

  if (!r.ok && !r.error) {
    if (!r.assetMatch) r.error = "returned id did not match expected price_id";
    else if (!r.sanityOk) r.error = `price ${priceNum} outside sanity range`;
    else if (typeof r.publishTime !== "number")
      r.error = "missing publish_time";
  }

  return r;
}

// Mirror of adapterHelpers.formatPythDecimal — duplicated so this script is
// truly standalone for the parsed-output table.
function formatPythDecimal(value: bigint, expo: number): string {
  if (expo === 0) return value.toString();
  if (expo > 0) return `${value.toString()}${"0".repeat(expo)}`;
  const decimals = -expo;
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const s = abs.toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  const intPart = s.slice(0, cut);
  const fracPart = s.slice(cut).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function indexParsedById(
  items: ReadonlyArray<HermesParsedItem>,
): Map<string, HermesParsedItem> {
  const m = new Map<string, HermesParsedItem>();
  for (const it of items) {
    const k = (it.id ?? "").toLowerCase();
    m.set(k.startsWith("0x") ? k.slice(2) : k, it);
  }
  return m;
}

function lookup(
  index: Map<string, HermesParsedItem>,
  price_id: string,
): HermesParsedItem | undefined {
  const k = price_id.startsWith("0x")
    ? price_id.slice(2).toLowerCase()
    : price_id.toLowerCase();
  return index.get(k);
}

interface AdapterSmokeRow {
  oracle_id: string;
  ok: boolean;
  price?: string;
  source_age_seconds?: number;
  source_id?: string;
  feed_timestamp?: string;
  error?: string;
}

async function adapterSmoke(): Promise<AdapterSmokeRow[]> {
  const rows: AdapterSmokeRow[] = [];
  for (const f of SEEDED) {
    const oracle: OracleRow = {
      oracle_id: f.oracle_id,
      asset_id: f.asset_id,
      adapter: "pyth-pull",
      config_json: JSON.stringify({ price_id: f.price_id }),
      // Fields below may exist on OracleRow; cast wide so we don't have to
      // know the exact schema offline. Adapter only reads the four above.
    } as OracleRow;
    const asset: AssetRow = {
      asset_id: f.asset_id,
      symbol: f.expectedAsset,
    } as AssetRow;
    try {
      const obs = await pythPullAdapter.getLatest(oracle, asset, {});
      rows.push({
        oracle_id: f.oracle_id,
        ok: true,
        price: obs.price,
        source_age_seconds: obs.source_age_seconds,
        source_id: obs.source_id,
        feed_timestamp: obs.feed_timestamp,
      });
    } catch (err) {
      rows.push({
        oracle_id: f.oracle_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

async function main(): Promise<number> {
  const startedAt = new Date();
  console.log("=".repeat(78));
  console.log("Pyth Hermes wiring probe");
  console.log(`endpoint:    ${HERMES_ENDPOINT}`);
  console.log(`probed_at:   ${startedAt.toISOString()}`);
  console.log(`feeds:       ${SEEDED.length}`);
  console.log("=".repeat(78));

  // 1. Per-feed single fetches
  console.log("\n[1] Per-feed single fetches");
  console.log("-".repeat(78));
  const perFeedReports: FeedReport[] = [];
  for (const f of SEEDED) {
    try {
      const resp = await hermesFetch([f.price_id]);
      const items = resp.parsed ?? [];
      const idx = indexParsedById(items);
      const hit = lookup(idx, f.price_id);
      const r = probeOne(f, hit, Math.floor(Date.now() / 1000));
      perFeedReports.push(r);
    } catch (err) {
      perFeedReports.push({
        oracle_id: f.oracle_id,
        expectedAsset: f.expectedAsset,
        shortId: fmtId(f.price_id),
        fullId: f.price_id,
        ok: false,
        assetMatch: false,
        sanityOk: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Print table
  const header = [
    pad("oracle_id", 22),
    pad("asset", 6),
    pad("price_id", 14),
    pad("price (USD)", 14),
    pad("conf bps", 10),
    pad("stale s", 8),
    pad("match", 6),
    "ok",
  ].join(" │ ");
  console.log(header);
  console.log("-".repeat(78));
  for (const r of perFeedReports) {
    const priceCell =
      typeof r.price === "number" ? fmtNumber(r.price, 2) : "-";
    const confCell =
      typeof r.confBps === "number" ? fmtNumber(r.confBps, 2) : "-";
    const staleCell =
      typeof r.staleness === "number" ? String(r.staleness) : "-";
    console.log(
      [
        pad(r.oracle_id, 22),
        pad(r.expectedAsset, 6),
        pad(r.shortId, 14),
        pad(priceCell, 14),
        pad(confCell, 10),
        pad(staleCell, 8),
        pad(r.assetMatch ? "yes" : "NO", 6),
        r.ok ? "yes" : "NO",
      ].join(" │ "),
    );
    if (r.error) console.log(`    ! ${r.error}`);
  }

  // 2. Batched multi-ID fetch
  console.log("\n[2] Batched multi-ID fetch (single round-trip, 4 ids)");
  console.log("-".repeat(78));
  let batchedOk = false;
  let batchedReports: FeedReport[] = [];
  try {
    const t0 = performance.now();
    const resp = await hermesFetch(SEEDED.map((s) => s.price_id));
    const elapsed = performance.now() - t0;
    const items = resp.parsed ?? [];
    const idx = indexParsedById(items);
    const nowSec = Math.floor(Date.now() / 1000);
    batchedReports = SEEDED.map((f) => probeOne(f, lookup(idx, f.price_id), nowSec));
    const allOk = batchedReports.every((r) => r.ok);
    console.log(
      `parsed entries returned: ${items.length} / ${SEEDED.length}` +
        ` (round-trip ${elapsed.toFixed(0)} ms)`,
    );
    for (const r of batchedReports) {
      const priceCell =
        typeof r.price === "number" ? fmtNumber(r.price, 2) : "-";
      console.log(
        `  - ${pad(r.expectedAsset, 4)} ${pad(r.shortId, 14)} ` +
          `price=${pad(priceCell, 12)} stale=${
            r.staleness ?? "?"
          }s match=${r.assetMatch ? "yes" : "NO"} ok=${r.ok ? "yes" : "NO"}`,
      );
    }
    batchedOk = allOk;
  } catch (err) {
    console.log(
      `  ! batched fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // 3. Latency benchmark
  console.log("\n[3] Latency benchmark — 5 sequential batched calls");
  console.log("-".repeat(78));
  const ids = SEEDED.map((s) => s.price_id);
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try {
      await hermesFetch(ids);
      const dt = performance.now() - t0;
      samples.push(dt);
      console.log(`  call ${i + 1}: ${dt.toFixed(1)} ms`);
    } catch (err) {
      console.log(
        `  call ${i + 1}: ERROR ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  let p50 = NaN,
    p95 = NaN,
    pmax = NaN;
  if (samples.length > 0) {
    p50 = percentile(samples, 50);
    p95 = percentile(samples, 95);
    pmax = Math.max(...samples);
    console.log(
      `  -> p50=${p50.toFixed(1)} ms  p95=${p95.toFixed(1)} ms  max=${pmax.toFixed(1)} ms  (n=${samples.length})`,
    );
  } else {
    console.log("  -> no samples (all calls errored)");
  }

  // 4. Adapter smoke against real Hermes
  console.log("\n[4] pythPullAdapter.getLatest smoke");
  console.log("-".repeat(78));
  const adapterRows = await adapterSmoke();
  for (const r of adapterRows) {
    if (r.ok) {
      console.log(
        `  ${pad(r.oracle_id, 22)} ok price=${r.price} age=${r.source_age_seconds}s source=${r.source_id} feed_ts=${r.feed_timestamp}`,
      );
    } else {
      console.log(`  ${pad(r.oracle_id, 22)} FAIL ${r.error}`);
    }
  }
  const adapterOk = adapterRows.every((r) => r.ok);

  // Summary
  console.log("\n" + "=".repeat(78));
  console.log("Summary");
  console.log("=".repeat(78));
  const perFeedOk = perFeedReports.every((r) => r.ok);
  const overallOk = perFeedOk && batchedOk && adapterOk;
  console.log(`  per-feed singles : ${perFeedOk ? "PASS" : "FAIL"}`);
  console.log(`  batched 4-id     : ${batchedOk ? "PASS" : "FAIL"}`);
  console.log(`  adapter smoke    : ${adapterOk ? "PASS" : "FAIL"}`);
  console.log(`  latency p50/p95  : ${Number.isFinite(p50) ? p50.toFixed(0) : "?"} ms / ${Number.isFinite(p95) ? p95.toFixed(0) : "?"} ms`);
  console.log(`  verdict          : ${overallOk ? "OK" : "ATTENTION"}`);
  console.log("");

  return overallOk ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error("probe crashed:", err);
    process.exit(1);
  });
