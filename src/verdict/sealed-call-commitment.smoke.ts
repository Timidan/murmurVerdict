import { strict as assert } from "node:assert";

import {
  parseStoredCommitment,
  revealedCommitmentEvidence,
} from "./sealed-call-commitment.js";
import type { Commitment } from "./markets-core.js";

process.stdout.write("murmur sealed call commitment smoke\n");

const commitment: Commitment = {
  marketRef: {
    protocol: "polymarket-gamma",
    sourceId: "condition-1",
    configVersion: 3,
  },
  predictedOutcome: {
    kind: "binary",
    payoutNumerators: [1n, 0n],
    payoutDenominator: 1n,
  },
  horizon: {
    iso: "2026-06-12T12:00:00Z",
    resolvesAfterMin: 30,
  },
  confidence: 0.64,
};

const stored = revealedCommitmentEvidence({
  commitment,
  outcomeLabels: ["YES", "NO"],
});
assert.deepEqual(JSON.parse(stored.commitment_json), {
  marketRef: {
    protocol: "polymarket-gamma",
    sourceId: "condition-1",
    configVersion: 3,
  },
  predictedOutcome: {
    kind: "binary",
    payoutNumerators: ["1", "0"],
    payoutDenominator: "1",
  },
  horizon: {
    iso: "2026-06-12T12:00:00Z",
    resolvesAfterMin: 30,
  },
  confidence: 0.64,
});
assert.deepEqual(JSON.parse(stored.predicted_outcome_json), {
  kind: "binary",
  payoutNumerators: ["1", "0"],
  payoutDenominator: "1",
});
assert.deepEqual(JSON.parse(stored.outcome_labels_json), ["YES", "NO"]);
assert.deepEqual(parseStoredCommitment(stored.commitment_json), commitment);
assert.equal(parseStoredCommitment(null), null);
assert.equal(parseStoredCommitment("{broken"), null);
assert.equal(parseStoredCommitment(JSON.stringify({ marketRef: null })), null);

const parseErrors: string[] = [];
assert.equal(
  parseStoredCommitment("{broken", {
    onParseError: (message) => parseErrors.push(message),
  }),
  null,
);
assert.equal(parseErrors.length, 1);
assert.match(parseErrors[0] ?? "", /JSON|Expected property name/i);

process.stdout.write("sealed call commitment smoke ok\n");
