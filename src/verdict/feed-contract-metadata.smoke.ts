import assert from "node:assert/strict";

import {
  coveredMarketIdsForFeed,
  feedContractMetadataJson,
  feedHasEdgeClass,
  feedHasResolutionClass,
  publicFeedContractMetadata,
} from "./feed-contract-metadata.js";

const stored = feedContractMetadataJson({
  resolution_classes: ["event_binary"],
  edge_classes: ["latency"],
  covered_market_ids: ["market-1", "market-2"],
  trigger_rules: [{ kind: "cadence", description: "every hour" }],
});
assert.deepEqual(publicFeedContractMetadata(stored), {
  resolution_classes: ["event_binary"],
  edge_classes: ["latency"],
  covered_market_ids: ["market-1", "market-2"],
  trigger_rules: [{ kind: "cadence", description: "every hour" }],
});
assert.deepEqual(coveredMarketIdsForFeed(stored), ["market-1", "market-2"]);
assert.equal(feedHasEdgeClass(stored, "latency"), true);
assert.equal(feedHasEdgeClass(stored, "domain"), false);
assert.equal(feedHasEdgeClass(stored, null), true);
assert.equal(feedHasResolutionClass(stored, "event_binary"), true);
assert.equal(feedHasResolutionClass(stored, "price_direction"), false);
assert.equal(feedHasResolutionClass(stored, null), true);

assert.throws(
  () => publicFeedContractMetadata({
    ...stored,
    covered_market_ids_json: "{broken",
  }),
  /feed\.covered_market_ids_json is malformed JSON/,
);
assert.deepEqual(coveredMarketIdsForFeed({ covered_market_ids_json: "{broken" }), []);
assert.deepEqual(coveredMarketIdsForFeed({ covered_market_ids_json: "{}" }), []);

process.stdout.write("feed contract metadata smoke ok\n");
