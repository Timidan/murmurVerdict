import assert from "node:assert/strict";

import type { Outcome } from "./markets-core.js";
import {
  publicResolutionOutcomeEvidence,
  resolutionOutcomeEvidenceJson,
} from "./resolution-outcome-evidence.js";

const outcome: Outcome = {
  kind: "binary",
  payoutNumerators: [1n, 0n],
  payoutDenominator: 1n,
  resolvedAt: 1_797_000_000,
  evidence: {
    sourceProtocol: "polymarket",
    sourceId: "0x" + "11".repeat(32),
    raw: { conditionId: "0x" + "22".repeat(32) },
  },
};

const stored = resolutionOutcomeEvidenceJson(outcome);

assert.deepEqual(JSON.parse(stored.resolved_outcome_json), {
  kind: "binary",
  payoutNumerators: ["1", "0"],
  payoutDenominator: "1",
  resolvedAt: 1_797_000_000,
  evidence: {
    sourceProtocol: "polymarket",
    sourceId: "0x" + "11".repeat(32),
    raw: { conditionId: "0x" + "22".repeat(32) },
  },
});
assert.deepEqual(JSON.parse(stored.payout_vector_json), ["1", "0"]);
assert.deepEqual(publicResolutionOutcomeEvidence(stored), {
  resolved_outcome: JSON.parse(stored.resolved_outcome_json),
  payout_vector: ["1", "0"],
});
assert.deepEqual(
  publicResolutionOutcomeEvidence({
    resolved_outcome_json: "{broken",
    payout_vector_json: JSON.stringify([1, "0"]),
  }),
  {},
);
assert.deepEqual(
  publicResolutionOutcomeEvidence({
    resolved_outcome_json: null,
    payout_vector_json: null,
  }),
  {},
);

console.log("resolution-outcome-evidence smoke ok");
