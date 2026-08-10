import assert from "node:assert/strict";

import {
  bindingFromReceipt,
  parseBinding,
  parseRevealArtifact,
  revealArtifactFromReceipt,
  serializeBinding,
  serializeRevealArtifact,
  type NanopayBinding,
} from "./single-stream-binding.js";
import type { NanopayReceiptRow } from "./repos/nanopay-receipts-repo.js";

const binding: NanopayBinding = {
  pipelineId: `0x${"1".repeat(64)}`,
  buyerAddress: `0x${"2".repeat(40)}`,
  requestSignalId: `0x${"3".repeat(64)}`,
  eip3009Nonce: `0x${"4".repeat(64)}`,
  circleTransactionUuid: "circle-transaction",
  anchor: {
    bindingVersion: 1,
    chainId: 84532,
    sealedVerdictsContractAddress: `0x${"5".repeat(40)}`,
    onchainCallId: `0x${"6".repeat(64)}`,
    marketId: "nanopay-market",
    agent: `0x${"7".repeat(40)}`,
    submitTxHash: `0x${"8".repeat(64)}`,
    submitLogIndex: 3,
    binaryIndexCiphertextHash: `0x${"9".repeat(64)}`,
    confidenceCiphertextHash: `0x${"a".repeat(64)}`,
    revealOpenAt: "2026-06-12T10:00:00Z",
    commitScheme: "fhenix-sealed-v1",
    commitHash: "b".repeat(64),
  },
};
assert.deepEqual(parseBinding(serializeBinding(binding)), binding);

const revealArtifact = { verdict: "UP", confidence: 0.72 };
assert.deepEqual(parseRevealArtifact(serializeRevealArtifact(revealArtifact)), revealArtifact);
assert.equal(serializeRevealArtifact(null), null);
assert.equal(parseRevealArtifact(null), null);

const receipt = receiptRow({
  binding_json: serializeBinding(binding),
  reveal_artifact_json: serializeRevealArtifact(revealArtifact),
});
assert.deepEqual(bindingFromReceipt(receipt), binding);
assert.deepEqual(revealArtifactFromReceipt(receipt), revealArtifact);
assert.equal(revealArtifactFromReceipt(receiptRow({ reveal_artifact_json: null })), null);

process.stdout.write("single stream binding smoke ok\n");

function receiptRow(
  overrides: Partial<NanopayReceiptRow>,
): NanopayReceiptRow {
  return {
    id: 1,
    payer: `0x${"2".repeat(40)}`,
    payment_handle: "circle-transaction",
    source_domain: "caip2:eip155:84532",
    payment_payload_hash: `0x${"c".repeat(64)}`,
    payment_requirements_hash: `0x${"d".repeat(64)}`,
    status: "settled",
    circle_transaction_uuid: "circle-transaction",
    pipeline_id: binding.pipelineId,
    request_signal_id: binding.requestSignalId,
    paid_amount_usdc_atoms: "1000",
    binding_json: serializeBinding(binding),
    reveal_artifact_json: null,
    created_at: "2026-06-12T09:00:00Z",
    settled_at: "2026-06-12T09:00:01Z",
    failed_at: null,
    failure_reason: null,
    ...overrides,
  };
}
