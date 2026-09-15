import assert from "node:assert/strict";

import {
  feedPacketCofheContractInputs,
  gatewayCofheInputJson,
  sealedCallCofheContractInputs,
} from "./fhenix-gateway-cofhe-input.js";
import type { CofheInput } from "./fhenix-gateway-schemas.js";

// One CoFHE 0.7 batch: two handles, ONE signature over both, security zone 0.
const BATCH_SIGNATURE = `0x${"5a".repeat(65)}`;

const euint8: CofheInput = {
  ct_hash: `0x${"11".repeat(32)}`,
  security_zone: 0,
  utype: 2,
  signature: BATCH_SIGNATURE,
};
const euint16: CofheInput = {
  ct_hash: `0x${"22".repeat(32)}`,
  security_zone: 0,
  utype: 3,
  signature: BATCH_SIGNATURE,
};

const sealed = sealedCallCofheContractInputs({
  binary_index_input_json: gatewayCofheInputJson(euint8),
  confidence_input_json: gatewayCofheInputJson(euint16),
});
assert.equal(sealed.firstHandle, euint8.ct_hash);
assert.equal(sealed.secondHandle, euint16.ct_hash);
assert.equal(sealed.inputProof, BATCH_SIGNATURE);

const packet = feedPacketCofheContractInputs({
  action_input_json: gatewayCofheInputJson(euint8),
  signal_input_json: gatewayCofheInputJson(euint16),
});
assert.equal(packet.firstHandle, euint8.ct_hash);
assert.equal(packet.secondHandle, euint16.ct_hash);
assert.equal(packet.inputProof, BATCH_SIGNATURE);

assert.throws(
  () =>
    sealedCallCofheContractInputs({
      binary_index_input_json: "{broken",
      confidence_input_json: gatewayCofheInputJson(euint16),
    }),
  /gateway_attempt\.binary_index_input_json is malformed JSON/,
);

assert.throws(
  () =>
    feedPacketCofheContractInputs({
      action_input_json: JSON.stringify({ ct_hash: "0x1234" }),
      signal_input_json: gatewayCofheInputJson(euint16),
    }),
  /gateway_feed_packet_attempt\.action_input_json is not a valid CoFHE input/,
);

// One signature covers keccak256(h_0 || h_1); differing signatures would revert on-chain.
assert.throws(
  () =>
    sealedCallCofheContractInputs({
      binary_index_input_json: gatewayCofheInputJson(euint8),
      confidence_input_json: gatewayCofheInputJson({
        ...euint16,
        signature: `0x${"7b".repeat(65)}`,
      }),
    }),
  /gateway_attempt: the two inputs carry different signatures/,
);

// Position and type are both bound into the digest: euint8 first, euint16
// second. A swapped pair is a different batch.
assert.throws(
  () =>
    sealedCallCofheContractInputs({
      binary_index_input_json: gatewayCofheInputJson(euint16),
      confidence_input_json: gatewayCofheInputJson(euint8),
    }),
  /gateway_attempt: first input must be CoFHE euint8/,
);

// 0.7 dropped runtime security zones; the contract rebuilds the digest with 0.
assert.throws(
  () =>
    sealedCallCofheContractInputs({
      binary_index_input_json: gatewayCofheInputJson({
        ...euint8,
        security_zone: 1,
      }),
      confidence_input_json: gatewayCofheInputJson(euint16),
    }),
  /gateway_attempt: first input security_zone must be 0/,
);

process.stdout.write("fhenix gateway CoFHE input smoke ok\n");
