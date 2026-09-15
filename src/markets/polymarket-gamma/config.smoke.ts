import { strict as assert } from "node:assert";

import {
  marketConfigSchema,
  polymarketGammaMarketConfig,
  polymarketGammaMarketConfigJson,
  publicPolymarketGammaMarketConfigSummary,
} from "./config.js";

process.stdout.write("murmur Polymarket Gamma Market Config smoke\n");

const conditionId = `0x${"a".repeat(64)}`;
const config = polymarketGammaMarketConfig({
  conditionId,
  snapshot: {
    slug: "will-eth-break-5k",
    outcomes: JSON.stringify(["YES", "NO"]),
    endDate: "2026-06-13T00:00:00Z",
    umaBond: "500",
    resolvedBy: "0x0000000000000000000000000000000000000001",
  },
  resolutionClass: "event_binary",
});

assert.deepEqual(config, {
  conditionId,
  slug: "will-eth-break-5k",
  outcomes: ["YES", "NO"],
  endDate: "2026-06-13T00:00:00Z",
  umaBond: "500",
  resolvedBy: "0x0000000000000000000000000000000000000001",
  resolution_class: "event_binary",
  gamma_url: "https://polymarket.com/event/will-eth-break-5k",
});
assert.deepEqual(marketConfigSchema.parse(config), config);
assert.equal(polymarketGammaMarketConfigJson({
  conditionId,
  snapshot: {
    slug: "will-eth-break-5k",
    outcomes: JSON.stringify(["YES", "NO"]),
    endDate: "2026-06-13T00:00:00Z",
  },
}), JSON.stringify({
  conditionId,
  slug: "will-eth-break-5k",
  outcomes: ["YES", "NO"],
  endDate: "2026-06-13T00:00:00Z",
  gamma_url: "https://polymarket.com/event/will-eth-break-5k",
}));

// Missing slug or outcomes are refused, never invented: both are published as market facts.
assert.throws(
  () =>
    polymarketGammaMarketConfig({
      conditionId,
      snapshot: { slug: "will-eth-break-5k", outcomes: "{broken" },
    }),
  /no usable outcome labels/,
  "unparseable outcomes are refused, not replaced with YES/NO",
);
assert.throws(
  () =>
    polymarketGammaMarketConfig({
      conditionId,
      snapshot: { outcomes: JSON.stringify(["YES", "NO"]) },
    }),
  /no slug/,
  "a missing slug is refused, not invented from the conditionId",
);

// Valid Gamma clobTokenIds persist as an immutable normalized-label → id map.
const withTokenIds = polymarketGammaMarketConfig({
  conditionId,
  snapshot: {
    slug: "btc-up-or-down",
    outcomes: JSON.stringify([" Up", "Down "]),
    clobTokenIds: JSON.stringify(["111", "222"]),
    endDate: "2026-06-13T00:00:00Z",
  },
});
assert.deepEqual(withTokenIds.clobTokenIds, { up: "111", down: "222" });
assert.deepEqual(marketConfigSchema.parse(withTokenIds), withTokenIds);

// Malformed / non-unique clobTokenIds are dropped, never guessed.
for (const clobTokenIds of [
  "{broken",
  JSON.stringify(["111"]),
  JSON.stringify(["111", "111"]),
  JSON.stringify(["111", ""]),
]) {
  const config2 = polymarketGammaMarketConfig({
    conditionId,
    snapshot: {
      slug: "btc-up-or-down",
      outcomes: JSON.stringify(["Up", "Down"]),
      clobTokenIds,
      endDate: "2026-06-13T00:00:00Z",
    },
  });
  assert.equal("clobTokenIds" in config2, false, clobTokenIds);
}

assert.deepEqual(
  publicPolymarketGammaMarketConfigSummary({
    ...config,
    private_note: "do not expose",
  }),
  {
    conditionId,
    slug: "will-eth-break-5k",
    outcomes: ["YES", "NO"],
    endDate: "2026-06-13T00:00:00Z",
    gamma_url: "https://polymarket.com/event/will-eth-break-5k",
  },
);

// ─── venue category + series projection ─────────────────────────────────────

{
  const base = {
    conditionId,
    snapshot: {
      slug: "will-eth-break-5k",
      outcomes: JSON.stringify(["YES", "NO"]),
      endDate: "2026-06-13T00:00:00Z",
    },
  };
  // The highest-precedence allowlisted slug wins regardless of position, with
  // its canonical label. Real Gamma tag order for a 5m series: `crypto` last.
  const tagged = JSON.parse(polymarketGammaMarketConfigJson({
    ...base,
    snapshot: {
      ...base.snapshot,
      events: [{
        tags: [
          { id: "102127", label: "Up or Down", slug: "up-or-down" },
          { id: "1312", label: "Crypto Prices", slug: "crypto-prices" },
          { id: "818", label: "Solana", slug: "solana" },
          { id: "21", label: " Crypto ", slug: "crypto" },
        ],
        series: [{ title: "ETH Up or Down 5m", slug: "eth-up-or-down-5m" }],
      }],
    },
  })) as Record<string, unknown>;
  assert.equal(tagged.venue_category, "Crypto", "allowlisted slug, canonical label");
  assert.equal(tagged.series_title, "ETH Up or Down 5m");
  assert.equal(tagged.series_slug, "eth-up-or-down-5m");

  // Precedence order decides, not tag id or position.
  const dual = JSON.parse(polymarketGammaMarketConfigJson({
    ...base,
    snapshot: {
      ...base.snapshot,
      events: [{
        tags: [
          { id: "2", label: "Tech", slug: "tech" },
          { id: "1401", label: "Politics", slug: "politics" },
        ],
      }],
    },
  })) as Record<string, unknown>;
  assert.equal(dual.venue_category, "Politics", "precedence order, never tag id");

  // Canonical label, not the venue's casing; ids are optional.
  const cased = JSON.parse(polymarketGammaMarketConfigJson({
    ...base,
    snapshot: {
      ...base.snapshot,
      events: [{ tags: [{ label: "health", slug: "health" }] }],
    },
  })) as Record<string, unknown>;
  assert.equal(cased.venue_category, "Health", "canonical label, not the venue's casing");

  // Untagged (our 5m series today) / malformed shapes: fields simply absent.
  for (const events of [
    undefined,
    null,
    "not-an-array",
    [],
    [{ tags: null, series: null }],
    [{ tags: [{ label: "" }, { nolabel: 1 }], series: [{ title: "  " }] }],
    // Real tags, none top-level: uncategorised.
    [{ tags: [{ id: "102127", label: "Up or Down", slug: "up-or-down" }] }],
    [{ tags: [{ id: "818", label: "Solana", slug: "solana" }] }],
  ]) {
    const cfg = JSON.parse(polymarketGammaMarketConfigJson({
      ...base,
      snapshot: { ...base.snapshot, ...(events === undefined ? {} : { events }) },
    })) as Record<string, unknown>;
    assert.equal("venue_category" in cfg, false, `no category for ${JSON.stringify(events)}`);
    assert.equal("series_title" in cfg, false, `no series for ${JSON.stringify(events)}`);
  }

  // Public summary allowlists the new fields — and only as non-empty strings.
  const summary = publicPolymarketGammaMarketConfigSummary(tagged);
  assert.equal(summary.venue_category, "Crypto");
  assert.equal(summary.series_title, "ETH Up or Down 5m");
  assert.equal("series_slug" in summary, false, "slug is internal, not public");
}

process.stdout.write("Polymarket Gamma Market Config smoke ok\n");
