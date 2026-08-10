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

// A snapshot Gamma could not supply is REFUSED, never patched up. Both of
// these fields are stored and published as real market facts: the slug becomes
// the public `gamma_url`, and the labels are rendered as the market's outcomes
// and used to resolve CLOB token ids. This case previously asserted the
// fabricated values (`conditionId.slice(0, 10)` as a slug, ["YES","NO"] as the
// outcomes of a market whose payload never said so).
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

process.stdout.write("Polymarket Gamma Market Config smoke ok\n");
