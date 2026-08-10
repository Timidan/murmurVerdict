// Client-side venue-config parsing, and specifically the icon gate.
//
// The daemon sanitizes `config_json.icon_url` on the read path
// (src/verdict/market-registry-public.ts, pinned by
// src/markets/polymarket-gamma/market-icon.smoke.ts). This is the second half
// of that belt-and-braces pair, and it lives here because the root tsconfig
// sets `rootDir: ./src` and excludes `dashboard`, so the daemon-side smoke
// cannot import this module.
//
// The two halves have to agree on what "https" means. They did not: the server
// parses with `new URL()` and requires a host, while this file tested
// `/^https:\/\//` — which accepts a bare `"https://"`. A prefix test that is
// looser than the parser it is supposed to back up is not a second check, it is
// a hole with a comment over it.

import { strict as assert } from "node:assert";

import {
  httpsUrl,
  marketAssetSymbol,
  marketDisplayName,
  parseMarketConfig,
} from "./market-meta.js";
import type { MarketRow } from "../api.js";

process.stdout.write("murmur dashboard market-meta smoke\n");

const ICON = "https://polymarket-upload.s3.us-east-2.amazonaws.com/SOL+fullsize.png";

function rowWith(config: Record<string, unknown> | null): MarketRow {
  return {
    market_id: `0x${"c".repeat(64)}`,
    ...(config === null ? {} : { config_json: JSON.stringify(config) }),
  } as unknown as MarketRow;
}

// ─── httpsUrl: the parser, not a prefix test ────────────────────────────────

assert.equal(httpsUrl(ICON), ICON, "a real https icon renders");
assert.equal(
  httpsUrl(`  ${ICON}  `),
  ICON,
  "surrounding whitespace is trimmed, matching the server",
);

for (const hostile of [
  "https://",
  "https:///",
  "HTTPS://",
  "http://insecure.example/icon.png",
  "javascript:alert(1)",
  "data:image/svg+xml;base64,PHN2Zy8+",
  "//protocol-relative.example/icon.png",
  "ftp://example.com/icon.png",
  "not a url at all",
  "",
  "   ",
  42,
  null,
  undefined,
  {},
  [ICON],
]) {
  assert.equal(
    httpsUrl(hostile),
    undefined,
    `rejected: ${JSON.stringify(hostile) ?? String(hostile)}`,
  );
}

// ─── parseMarketConfig routes icon_url through that gate ────────────────────

{
  const cfg = parseMarketConfig(
    rowWith({
      question: "Bitcoin Up or Down?",
      slug: "btc-updown-5m-1786340100",
      outcomes: ["Up", "Down"],
      endDate: "2026-08-10T05:45:00Z",
      gamma_url: "https://polymarket.com/event/btc-updown-5m-1786340100",
      icon_url: ICON,
    }),
  )!;
  assert.equal(cfg.icon_url, ICON);
  assert.equal(cfg.question, "Bitcoin Up or Down?");
  assert.deepEqual(cfg.outcomes, ["Up", "Down"]);
}

// A hostile icon costs the market its artwork, never its other fields — the
// renderer's glyph fallback keys on `icon_url === undefined`.
for (const hostile of ["https://", "http://insecure.example/a.png", "javascript:alert(1)"]) {
  const cfg = parseMarketConfig(
    rowWith({ slug: "btc-updown-5m-1", outcomes: ["Up", "Down"], icon_url: hostile }),
  )!;
  assert.equal(cfg.icon_url, undefined, `icon dropped: ${hostile}`);
  assert.equal(cfg.slug, "btc-updown-5m-1", "the rest of the blob survives");
  assert.deepEqual(cfg.outcomes, ["Up", "Down"]);
}

// Native price markets carry no config_json, and a malformed blob is not a
// partial parse.
assert.equal(parseMarketConfig(rowWith(null)), null, "no config_json → null");
assert.equal(
  parseMarketConfig({ market_id: "x", config_json: "{not json" } as unknown as MarketRow),
  null,
  "malformed config_json → null",
);

// ─── The derivations the grid depends on still hold ─────────────────────────

assert.equal(
  marketAssetSymbol(rowWith({ slug: "doge-updown-5m-1786340100" })),
  "DOGE",
  "the asset comes from the slug, not the synthetic asset_id",
);
assert.equal(
  marketAssetSymbol(rowWith({ question: "Ethereum Up or Down on August 10?" })),
  "ETH",
  "…with the question as the fallback",
);
assert.equal(
  marketAssetSymbol(rowWith({ slug: "some-other-market" })),
  null,
  "an unknown asset is null, never a guess",
);

assert.equal(
  marketDisplayName(rowWith({ question: "Will it rain?" })),
  "Will it rain?",
);
assert.equal(
  marketDisplayName(rowWith({ slug: "btc-updown-5m-1786340100" })),
  "Btc updown 5m",
  "the slug fallback drops the trailing disambiguator",
);
assert.equal(
  marketDisplayName(rowWith(null)),
  `0x${"c".repeat(64)}`,
  "and the market id is the last resort",
);

process.stdout.write("OK dashboard market-meta smoke\n");
