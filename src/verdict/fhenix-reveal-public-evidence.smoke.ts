import { strict as assert } from "node:assert";

import {
  fhenixRevealConfidence,
  publicFhenixInvalidRevealIngestionBody,
  publicFhenixRevealEvidence,
  publicFhenixRevealIngestionBody,
} from "./fhenix-reveal-public-evidence.js";
import type { FhenixSealedCallRow } from "./repos/fhenix-sealed-calls-repo.js";

process.stdout.write("murmur fhenix reveal public evidence smoke\n");

const base: FhenixSealedCallRow = {
  call_id: "call-1",
  chain_id: 8453,
  contract_address: "0x" + "1".repeat(40),
  onchain_call_id: "0x" + "2".repeat(64),
  submit_tx_hash: "0x" + "3".repeat(64),
  submit_log_index: 1,
  binary_index_ct_hash: "0x" + "4".repeat(64),
  confidence_ct_hash: "0x" + "5".repeat(64),
  reveal_open_at: "2026-05-16T11:00:00Z",
  submission_class: 1,
  created_at: "2026-05-16T10:00:00Z",
  opened_at: null,
  reveal_status: "pending",
  invalid_reason: null,
  terminal_at: null,
  submit_block_number: null,
  reveal_block_number: null,
  revealed_at: null,
  reveal_tx_hash: null,
  reveal_log_index: null,
  revealed_binary_index: null,
  revealed_confidence: null,
  revealed_confidence_bps: null,
  reveal_sender: null,
  reveal_source: null,
};

const pending = publicFhenixRevealEvidence(base);
assert.equal(pending?.reveal_status, "pending");
assert.equal("revealed_verdict" in (pending ?? {}), false);

const revealed = publicFhenixRevealEvidence({
  ...base,
  reveal_status: "revealed",
  revealed_at: "2026-05-16T11:00:01Z",
  terminal_at: "2026-05-16T11:00:01Z",
  revealed_binary_index: 1,
  revealed_confidence: null,
  revealed_confidence_bps: 7200,
});
assert.equal(revealed?.revealed_verdict?.binary_index, 1);
assert.equal(revealed?.revealed_verdict?.confidence_bps, 7200);
assert.equal(revealed?.revealed_verdict?.confidence, 0.72);
assert.equal(revealed?.revealed_verdict?.outcome_label, undefined);

// The venue's word for the revealed index rides along when the venue named one.
const labelled = publicFhenixRevealEvidence(
  {
    ...base,
    reveal_status: "revealed",
    revealed_at: "2026-05-16T11:00:01Z",
    revealed_binary_index: 1,
    revealed_confidence_bps: 7200,
  },
  ["Up", "Down"],
);
assert.equal(labelled?.revealed_verdict?.outcome_label, "Down");

// `outcome_N` is the resolver's own placeholder, not a venue word: dropped.
const unlabelled = publicFhenixRevealEvidence(
  {
    ...base,
    reveal_status: "revealed",
    revealed_at: "2026-05-16T11:00:01Z",
    revealed_binary_index: 1,
    revealed_confidence_bps: 7200,
  },
  ["outcome_0", "outcome_1"],
);
assert.equal(unlabelled?.revealed_verdict?.outcome_label, undefined);

assert.deepEqual(
  publicFhenixRevealIngestionBody({
    call_id: "call-2",
    binary_index: 0,
    confidence_bps: 8300,
    revealed_at: "2026-05-16T11:00:02Z",
    outcomeLabels: ["YES", "NO"],
  }),
  {
    call_id: "call-2",
    privacy_mode: "sealed_fhenix",
    status: "revealed",
    revealed_at: "2026-05-16T11:00:02Z",
    revealed_verdict: {
      binary_index: 0,
      outcome_label: "YES",
      confidence_bps: 8300,
      confidence: 0.83,
    },
  },
);

assert.deepEqual(
  publicFhenixInvalidRevealIngestionBody({
    call_id: "call-3",
    binary_index: 2,
    confidence_bps: 7000,
    invalid_reason: "binary_index",
    revealed_at: "2026-05-16T11:00:03Z",
  }),
  {
    call_id: "call-3",
    privacy_mode: "sealed_fhenix",
    status: "invalid_reveal",
    invalid_reason: "binary_index",
    revealed_at: "2026-05-16T11:00:03Z",
    revealed_verdict: {
      binary_index: 2,
      confidence_bps: 7000,
    },
  },
);

assert.equal(fhenixRevealConfidence(0.91, 7200), 0.91);
assert.equal(fhenixRevealConfidence(null, 7200), 0.72);

process.stdout.write("fhenix reveal public evidence smoke ok\n");
