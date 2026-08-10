import assert from "node:assert/strict";

import {
  feedPacketCofheContractInputs,
  gatewayCofheInputJson,
  sealedCallCofheContractInputs,
} from "./fhenix-gateway-cofhe-input.js";
import type { CofheInput } from "./fhenix-gateway-schemas.js";

const euint8: CofheInput = {
  ct_hash: `0x${"11".repeat(32)}`,
  security_zone: 1,
  utype: 2,
  signature: "0x1234",
};
const euint16: CofheInput = {
  ct_hash: `0x${"22".repeat(32)}`,
  security_zone: 2,
  utype: 3,
  signature: "0xabcd",
};

const sealed = sealedCallCofheContractInputs({
  binary_index_input_json: gatewayCofheInputJson(euint8),
  confidence_input_json: gatewayCofheInputJson(euint16),
});
assert.equal(sealed.binaryIndex.ctHash, BigInt(euint8.ct_hash));
assert.equal(sealed.binaryIndex.securityZone, 1);
assert.equal(sealed.binaryIndex.utype, 2);
assert.equal(sealed.binaryIndex.signature, "0x1234");
assert.equal(sealed.confidence.ctHash, BigInt(euint16.ct_hash));
assert.equal(sealed.confidence.utype, 3);

const packet = feedPacketCofheContractInputs({
  action_input_json: gatewayCofheInputJson(euint8),
  signal_input_json: gatewayCofheInputJson(euint16),
});
assert.equal(packet.action.ctHash, BigInt(euint8.ct_hash));
assert.equal(packet.signal.ctHash, BigInt(euint16.ct_hash));

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

process.stdout.write("fhenix gateway CoFHE input smoke ok\n");
