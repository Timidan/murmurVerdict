import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import {
  ARCHIVE_MAX_LIMIT,
  ARCHIVE_MAX_QUERY_CHARS,
  decodeArchiveCursor,
  encodeArchiveCursor,
  escapeLikeTerm,
  marketArchiveSurface,
  type MarketArchiveBody,
} from "./market-archive-surface.js";
import { SCHEMA_VERSION } from "./schema.js";

process.stdout.write("murmur markets archive surface smoke\n");

const tmp = mkdtempSync(join(tmpdir(), "archive-surface-"));
const db = openDb({ path: join(tmp, "verdict.db") });

// ─── Fixture ────────────────────────────────────────────────────────────────
//
// Eleven frozen markets across three end instants, plus the states the query
// must EXCLUDE (a listed row, and a row whose two tables disagree). Two rows
// share one end instant so the keyset tie-break is actually exercised — a
// cursor that only carries the timestamp would either repeat or skip one of
// them, and a single-row-per-instant fixture would never catch it.

const T0 = 1_786_300_000; // oldest
const T1 = 1_786_300_300;
const T2 = 1_786_300_600; // newest

function conditionId(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

let nextId = 1;
function seedMarket(input: {
  endEpochS: number;
  question: string;
  slug: string;
  status?: string;
  marketStatus?: string;
  iconUrl?: string | null;
  withClock?: boolean;
}): string {
  const id = conditionId(nextId++);
  const config: Record<string, unknown> = {
    conditionId: id,
    question: input.question,
    slug: input.slug,
    outcomes: ["Up", "Down"],
    endDate: new Date(input.endEpochS * 1000).toISOString(),
    gamma_url: `https://polymarket.com/event/${input.slug}`,
  };
  if (input.iconUrl !== undefined && input.iconUrl !== null) {
    config.icon_url = input.iconUrl;
  }
  db.prepare(
    `INSERT INTO markets (
       market_id, asset_id, market_kind, horizon_seconds, primary_oracle_id,
       fallback_oracle_id, primary_max_staleness_sec, fallback_max_staleness_sec,
       t0_grace_seconds, t0_extended_grace_seconds, void_band,
       round_cadence_seconds, scoring_kind, market_config_version, status,
       notes, created_at, adapter_id, market_family, config_json)
     VALUES (@market_id, 'polymarket:event', 'event_binary', 300,
       'polymarket-gamma-oracle', NULL, 300, NULL, 0, 0, '0', NULL,
       'multinomial_brier', 1, @status, NULL, @created_at, 'polymarket-gamma',
       'prediction-market-binary', @config_json)`,
  ).run({
    market_id: id,
    status: input.marketStatus ?? "frozen",
    created_at: "2026-08-10T00:00:00Z",
    config_json: JSON.stringify(config),
  });
  db.prepare(
    `INSERT INTO polymarket_discovery_state (
       condition_id, question, slug, end_date_epoch_s, status, attempt_count,
       created_at, updated_at)
     VALUES (@condition_id, @question, @slug, @end_date_epoch_s, @status, 0,
       @now, @now)`,
  ).run({
    condition_id: id,
    question: input.question,
    slug: input.slug,
    end_date_epoch_s: input.endEpochS,
    status: input.status ?? "frozen",
    now: "2026-08-10T00:00:00Z",
  });
  if (input.withClock) {
    db.prepare(
      `INSERT OR IGNORE INTO market_series (
         series_id, venue, display_name, window_seconds, submission_open_lead_sec,
         commit_margin_sec, delivery_budget_sec, embargo_sec, max_armed_per_call,
         status, created_at, updated_at)
       VALUES ('smoke:300s', 'polymarket', 'smoke', 300, 300, 60, 60, 600, 25,
         'active', @now, @now)`,
    ).run({ now: "2026-08-10T00:00:00Z" });
    const endMs = input.endEpochS * 1000;
    db.prepare(
      `INSERT INTO market_clocks (
         market_id, series_id, arm_close_at_ms, submission_open_at_ms,
         early_access_cutoff_at_ms, submission_close_at_ms, resolution_at_ms,
         public_reveal_at_ms, derived_from_end_date_ms, drift_detected_at,
         created_at)
       VALUES (@market_id, 'smoke:300s', @arm, @open, @early, @close, @res,
         @reveal, @derived, NULL, @now)`,
    ).run({
      market_id: id,
      arm: endMs - 900_000,
      open: endMs - 600_000,
      early: endMs - 400_000,
      close: endMs - 300_000,
      res: endMs,
      reveal: endMs + 600_000,
      derived: endMs,
      now: "2026-08-10T00:00:00Z",
    });
  }
  return id;
}

const ICON = "https://polymarket-upload.s3.us-east-2.amazonaws.com/BTC.png";

const t2a = seedMarket({
  endEpochS: T2,
  question: "Bitcoin Up or Down - August 10, 2:00AM-2:05AM ET",
  slug: "btc-updown-5m-b",
  iconUrl: ICON,
  withClock: true,
});
const t2b = seedMarket({
  endEpochS: T2,
  question: "Ethereum Up or Down - August 10, 2:00AM-2:05AM ET",
  slug: "eth-updown-5m-b",
});
seedMarket({
  endEpochS: T1,
  question: "Solana Up or Down - August 10, 1:55AM-2:00AM ET",
  slug: "sol-updown-5m-a",
});
seedMarket({
  endEpochS: T0,
  question: "Dogecoin Up or Down - August 10, 1:50AM-1:55AM ET",
  slug: "doge-updown-5m-a",
});
// The literal-metacharacter row: only an ESCAPED search must find it.
seedMarket({
  endEpochS: T0,
  question: "Will inflation exceed 100% this year?",
  slug: "inflation-100-percent",
});
// A row with a NON-https icon in storage — the read path must drop it even
// though ingestion should never have written it.
seedMarket({
  endEpochS: T0,
  question: "Legacy row with an http icon",
  slug: "legacy-http-icon",
  iconUrl: "http://insecure.example/icon.png",
});
// Excluded: still listed on both sides.
seedMarket({
  endEpochS: T2,
  question: "XRP Up or Down - still running",
  slug: "xrp-updown-live",
  status: "listed",
  marketStatus: "listed",
});
// Excluded: the two tables disagree (mid-transition).
seedMarket({
  endEpochS: T2,
  question: "Half-frozen market",
  slug: "half-frozen",
  status: "frozen",
  marketStatus: "listed",
});

function run(query: Record<string, unknown>) {
  return marketArchiveSurface({ db, query });
}

function ok(query: Record<string, unknown>): MarketArchiveBody {
  const result = run(query);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body as MarketArchiveBody;
}

// ─── 1. Input hardening ─────────────────────────────────────────────────────

for (const [label, query] of [
  ["no filter at all", {}],
  ["one-character term", { q: "b" }],
  ["whitespace-only term", { q: "   " }],
  ["term of one non-space char plus spaces", { q: " b " }],
  ["over-long term", { q: "x".repeat(ARCHIVE_MAX_QUERY_CHARS + 1) }],
  ["non-string term", { q: 42 }],
  ["unparseable from", { from: "not-a-date" }],
  ["unparseable to", { to: "yesterday" }],
  ["inverted range", { from: T2, to: T0 }],
  ["zero limit", { q: "bitcoin", limit: "0" }],
  ["fractional limit", { q: "bitcoin", limit: "2.5" }],
  ["non-numeric limit", { q: "bitcoin", limit: "many" }],
] as Array<[string, Record<string, unknown>]>) {
  const result = run(query);
  assert.equal(result.status, 400, `${label} must be rejected`);
  assert.equal(
    (result.body as { code: string }).code,
    "archive_query_invalid",
    label,
  );
}

for (const cursor of [
  "not-base64!!",
  Buffer.from("no-separator", "utf8").toString("base64url"),
  Buffer.from("|0xabc", "utf8").toString("base64url"),
  Buffer.from("notanumber|0xabc", "utf8").toString("base64url"),
  Buffer.from(`${T2}|has spaces`, "utf8").toString("base64url"),
  Buffer.from(`0|${t2a}`, "utf8").toString("base64url"),
]) {
  const result = run({ q: "bitcoin", cursor });
  assert.equal(result.status, 400, `malformed cursor rejected: ${cursor}`);
  assert.equal((result.body as { code: string }).code, "archive_cursor_invalid");
}

// A date bound ALONE is a valid request — no term required.
assert.ok(ok({ from: T0, to: T2 }).results.length > 0, "date-only search works");

// A too-short term riding along with a date filter is dropped, not applied:
// the date bound is what carries the request.
assert.deepEqual(
  ok({ q: "b", from: T0, to: T2 }).results.map((r) => r.market_id),
  ok({ from: T0, to: T2 }).results.map((r) => r.market_id),
  "a sub-minimum term beside a date filter changes nothing",
);

// limit above the cap CLAMPS rather than erroring.
assert.equal(
  ok({ from: T0, to: T2, limit: 9999 }).returned,
  Math.min(ARCHIVE_MAX_LIMIT, ok({ from: T0, to: T2 }).returned),
  "limit clamps to the cap",
);

// ─── 2. LIKE escaping ───────────────────────────────────────────────────────

assert.equal(escapeLikeTerm("100%"), "100\\%");
assert.equal(escapeLikeTerm("a_b"), "a\\_b");
assert.equal(escapeLikeTerm("back\\slash"), "back\\\\slash");
assert.equal(escapeLikeTerm("plain"), "plain");

// A bare `%` must be a literal percent sign, NOT "match everything".
{
  const wildcardAttempt = ok({ q: "%%" });
  assert.equal(
    wildcardAttempt.results.length,
    0,
    "'%%' is a literal search, not a wildcard that returns the whole archive",
  );
}
{
  const literalPercent = ok({ q: "100%" });
  assert.equal(literalPercent.results.length, 1, "the literal 100% row is found");
  assert.equal(literalPercent.results[0]!.slug, "inflation-100-percent");
}
{
  // `_` must not act as "any character": "1_0" would match "100" if unescaped.
  const underscore = ok({ q: "1_0" });
  assert.equal(underscore.results.length, 0, "'_' is a literal underscore");
}

// Case-insensitive across BOTH searchable columns.
assert.equal(ok({ q: "BITCOIN" }).results.length, 1, "question match, any case");
assert.equal(ok({ q: "DOGE-UPDOWN" }).results.length, 1, "slug match, any case");

// ─── 3. Status filtering ────────────────────────────────────────────────────

{
  const all = ok({ from: 0, to: T2 + 1 });
  const ids = new Set(all.results.map((r) => r.market_id));
  assert.equal(all.results.length, 6, "only the six doubly-frozen rows appear");
  for (const row of all.results) {
    assert.notEqual(row.slug, "xrp-updown-live", "a listed market is not archived");
    assert.notEqual(row.slug, "half-frozen", "a half-frozen market is excluded");
  }
  assert.ok(ids.has(t2a) && ids.has(t2b));
}

// ─── 4. Ordering + keyset cursor walk ───────────────────────────────────────

{
  const everything = ok({ from: 0, to: T2 + 1 }).results;
  const stamps = everything.map((r) => Date.parse(r.ended_at));
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i]! <= stamps[i - 1]!, "newest end date first");
  }
  // The tie is broken by condition_id DESC, so the two T2 rows are adjacent
  // and in descending id order.
  const tied = everything.filter((r) => Date.parse(r.ended_at) === T2 * 1000);
  assert.equal(tied.length, 2, "both tied rows present");
  assert.ok(tied[0]!.market_id > tied[1]!.market_id, "tie-break is id DESC");

  // Walk the whole archive one row at a time. Every row must appear exactly
  // once, in the same order as the unpaged read — the property a keyset page
  // exists to guarantee and an OFFSET page silently loses.
  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: MarketArchiveBody = ok({
      from: 0,
      to: T2 + 1,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.returned, page.results.length);
    assert.ok(page.returned <= 1, "limit is honored");
    for (const row of page.results) walked.push(row.market_id);
    assert.equal(
      page.has_more,
      page.next_cursor !== null,
      "next_cursor and has_more agree",
    );
    cursor = page.next_cursor;
    pages += 1;
    assert.ok(pages < 50, "cursor walk terminates");
  } while (cursor !== null);

  assert.deepEqual(
    walked,
    everything.map((r) => r.market_id),
    "a one-row-at-a-time walk reproduces the unpaged order with no gaps or repeats",
  );
  assert.equal(new Set(walked).size, walked.length, "no row is served twice");
}

// has_more is false on a page that exactly exhausts the result set — the n+1
// probe must not report a phantom next page.
{
  const exact = ok({ from: 0, to: T2 + 1, limit: 6 });
  assert.equal(exact.returned, 6);
  assert.equal(exact.has_more, false, "an exactly-full final page has no more");
  assert.equal(exact.next_cursor, null);

  const short = ok({ from: 0, to: T2 + 1, limit: 5 });
  assert.equal(short.returned, 5);
  assert.equal(short.has_more, true, "a truncated page reports more");
  assert.notEqual(short.next_cursor, null);
}

// ─── 5. Date bounds are INCLUSIVE ───────────────────────────────────────────

{
  const single = ok({ from: T1, to: T1 });
  assert.equal(single.results.length, 1, "an exact-instant range is inclusive");
  assert.equal(single.results[0]!.slug, "sol-updown-5m-a");
}
assert.equal(
  ok({ from: new Date(T1 * 1000).toISOString(), to: new Date(T1 * 1000).toISOString() })
    .results.length,
  1,
  "ISO-8601 bounds work as well as epoch seconds",
);

// ─── 6. Row projection ──────────────────────────────────────────────────────

{
  const page = ok({ q: "bitcoin" });
  assert.equal(page.schema_version, SCHEMA_VERSION);
  const row = page.results[0]!;
  assert.equal(row.market_id, t2a);
  assert.equal(row.ended_at, new Date(T2 * 1000).toISOString());
  assert.equal(row.icon_url, ICON, "an https icon_url is served through");
  assert.equal(row.sealed_window, true, "a market with a clock row is flagged");
  assert.deepEqual(Object.keys(row).sort(), [
    "ended_at",
    "icon_url",
    "market_id",
    "question",
    "sealed_window",
    "slug",
  ]);
}
assert.equal(
  ok({ q: "ethereum" }).results[0]!.sealed_window,
  false,
  "a market with no clock row is not flagged — the join must be LEFT",
);
assert.equal(
  ok({ q: "ethereum" }).results[0]!.icon_url,
  null,
  "a config with no icon_url yields null, never a placeholder",
);
assert.equal(
  ok({ q: "legacy-http-icon" }).results[0]!.icon_url,
  null,
  "a non-https icon stored by a legacy row is dropped on the way out",
);

// ─── 7. Cursor codec round-trip ─────────────────────────────────────────────

{
  const cursor = encodeArchiveCursor({ endEpochS: T2, conditionId: t2a });
  assert.deepEqual(decodeArchiveCursor(cursor), {
    endEpochS: T2,
    conditionId: t2a,
  });
  assert.equal(
    cursor.includes(t2a),
    false,
    "the cursor is opaque — the raw id is not readable in it",
  );
}

// ─── 8. The cursor is CANONICAL ─────────────────────────────────────────────
//
// Node's base64 decoder is lenient: it skips characters it does not recognize
// and tolerates a truncated final group, so an unbounded number of distinct
// strings used to decode to the same page. "Opaque page token" has to mean one
// page has exactly one token, or the token is not a token — it is a format with
// undocumented slack that clients will eventually depend on.

{
  const canonical = encodeArchiveCursor({ endEpochS: T2, conditionId: t2a });
  assert.notEqual(decodeArchiveCursor(canonical), null, "the real cursor decodes");

  for (const [label, mutated] of [
    ["trailing padding", `${canonical}=`],
    ["double padding", `${canonical}==`],
    ["trailing newline", `${canonical}\n`],
    ["embedded space", `${canonical.slice(0, 4)} ${canonical.slice(4)}`],
    ["standard-alphabet '+' smuggled in", `${canonical}+`],
    ["a stray character the decoder skips", `${canonical}*`],
  ] as Array<[string, string]>) {
    assert.equal(
      decodeArchiveCursor(mutated),
      null,
      `non-canonical cursor rejected: ${label}`,
    );
    const result = run({ q: "bitcoin", cursor: mutated });
    assert.equal(result.status, 400, `${label} is a 400`);
    assert.equal((result.body as { code: string }).code, "archive_cursor_invalid");
  }
}

// ─── 9. Dates are parsed STRICTLY, not by Date.parse ───────────────────────
//
// `Date.parse` is a dialect parser, not a validator. It rolls February 30
// forward to March 2 (a filter answering a question nobody asked), accepts
// locale forms whose meaning differs by engine, and happily returns a negative
// instant for a pre-epoch date — slipping past the `>= 0` check the numeric
// branch applies.

for (const [label, value] of [
  ["February 30 (rolls over silently)", "2026-02-30"],
  ["February 31", "2026-02-31T00:00:00Z"],
  ["month 13", "2026-13-01"],
  ["day 00", "2026-08-00"],
  ["hour 24", "2026-08-10T24:00:00Z"],
  ["minute 60", "2026-08-10T00:60:00Z"],
  ["US locale form", "3/3/2026"],
  ["long-form locale date", "March 3, 2026"],
  ["RFC-1123 form", "Tue, 10 Aug 2026 00:00:00 GMT"],
  ["a numeric offset instead of Z", "2026-08-10T00:00:00+02:00"],
  ["a local time with no zone", "2026-08-10T00:00:00"],
  ["pre-epoch ISO", "1960-01-01T00:00:00Z"],
  ["year zero", "0000-01-01T00:00:00Z"],
  ["unpadded month", "2026-8-10"],
  // Sub-second precision has nowhere to land: `end_date_epoch_s` is stored in
  // SECONDS, so the fraction was floored away and `…:59.999Z` silently behaved
  // as `…:59.000Z` — quietly widening the range by most of a second and
  // including a row the caller asked to exclude.
  ["non-zero milliseconds", "2026-08-10T00:00:59.999Z"],
  ["a single non-zero digit", "2026-08-10T00:00:00.1Z"],
  ["microsecond precision", "2026-08-10T00:00:00.000001Z"],
] as Array<[string, string]>) {
  for (const field of ["from", "to"] as const) {
    const result = run({ [field]: value });
    assert.equal(result.status, 400, `${field}=${label} must be rejected`);
    assert.equal(
      (result.body as { code: string }).code,
      "archive_query_invalid",
      label,
    );
  }
}

// …while every shape the contract actually promises still works.
{
  assert.ok(
    ok({ from: String(T0), to: String(T2) }).results.length > 0,
    "epoch seconds as a string are accepted",
  );
  assert.ok(ok({ from: 0, to: T2 + 1 }).results.length > 0, "from=0 is a real bound");
  assert.equal(
    ok({ from: "2026-08-10", to: "2026-08-10" }).results.length,
    0,
    "a bare calendar date parses as UTC midnight (no rows that day)",
  );
  const isoDay = ok({ from: 0, to: "2026-08-10T00:00:00Z" });
  const isoZeroFraction = ok({ from: 0, to: "2026-08-10T00:00:00.000Z" });
  assert.deepEqual(
    isoDay.results.map((r) => r.market_id),
    isoZeroFraction.results.map((r) => r.market_id),
    "a ZERO fraction is accepted — it is what toISOString() emits — and means " +
      "exactly the same instant",
  );
  // The bound a rejected fraction would have silently become. Proving these two
  // select DIFFERENT rows is what makes the rejection worth having: accepting
  // `.999` as `.000` is not a rounding detail, it changes the answer.
  const T1_ISO = new Date(T1 * 1000).toISOString();
  assert.equal(run({ from: 0, to: T1_ISO }).status, 200);
  assert.equal(
    ok({ from: 0, to: T1_ISO }).results.some((r) => Date.parse(r.ended_at) === T1 * 1000),
    true,
    "the exact-second bound is inclusive",
  );
  assert.equal(
    run({ from: 0, to: T1_ISO.replace(".000Z", ".999Z") }).status,
    400,
    "…and the fraction that would have been discarded is refused outright",
  );
  assert.equal(
    ok({ from: 0, to: String(T1 - 1) }).results.some(
      (r) => Date.parse(r.ended_at) === T1 * 1000,
    ),
    false,
    "one second earlier really does exclude that row — the bound is load-bearing",
  );
  // A leap day is a real date and must survive the round-trip check.
  assert.equal(run({ from: "2024-02-29T00:00:00Z" }).status, 200);
  assert.equal(run({ from: "2026-02-29" }).status, 400, "…but only in a leap year");
}

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK markets archive surface smoke\n");
