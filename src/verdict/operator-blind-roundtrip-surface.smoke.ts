import assert from "node:assert/strict";

import {
  OPERATOR_BLIND_FHENIX_ONCHAIN_CALL_ID_KEY,
  OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS,
  OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY,
  OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS,
  OPERATOR_BLIND_SENTINEL_BINARY_INDEX,
  OPERATOR_BLIND_SENTINEL_CONFIDENCE_MAX,
  OPERATOR_BLIND_SENTINEL_CONFIDENCE_MIN,
  OperatorBlindRoundtripError,
  assertOperatorBlindDashboardPostRevealText,
  assertOperatorBlindDashboardPreRevealText,
  assertOperatorBlindRevealSnapshotPlaintext,
  assertOperatorBlindSealedSnapshotOpaque,
  findOperatorBlindNumericLeaf,
  makeOperatorBlindClientNonce,
  normalizeOperatorBlindBytesHex,
  normalizeOperatorBlindCtHashToHex32,
  operatorBlindClientOrderId,
  operatorBlindRationale,
  operatorBlindSentinelTextForms,
  randomOperatorBlindConfidenceSentinel,
  startOperatorBlindRoundtrip,
} from "./operator-blind-roundtrip-surface.js";

process.stdout.write("murmur operator blind roundtrip surface smoke\n");

const minSentinel = randomOperatorBlindConfidenceSentinel(() => 0);
const maxSentinel = randomOperatorBlindConfidenceSentinel(() => 0.999999);
assert.equal(minSentinel, OPERATOR_BLIND_SENTINEL_CONFIDENCE_MIN);
assert.equal(maxSentinel, OPERATOR_BLIND_SENTINEL_CONFIDENCE_MAX);
assert.deepEqual(operatorBlindSentinelTextForms(7531), ["7531", "75.31%"]);
assert.throws(
  () => randomOperatorBlindConfidenceSentinel(() => 1),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "run" &&
    /random sentinel Adapter/.test(err.detail),
);

const run = startOperatorBlindRoundtrip({
  nowMs: () => 1_781_234_567_890,
  newRunToken: () => "token",
  newSentinelConfidence: () => 7531,
});
assert.deepEqual(run, {
  startedAtMs: 1_781_234_567_890,
  runId: "ob-1781234567890-token",
  sentinelConfidence: 7531,
  sentinelBinaryIndex: OPERATOR_BLIND_SENTINEL_BINARY_INDEX,
});

const nonce = makeOperatorBlindClientNonce({
  runId: run.runId,
  nonceEntropy: "entropy",
});
assert.match(nonce, /^0x[0-9a-f]{64}$/);
assert.equal(
  makeOperatorBlindClientNonce({ runId: run.runId, nonceEntropy: "entropy" }),
  nonce,
);
assert.equal(
  operatorBlindClientOrderId(run.runId, nonce),
  `ob-1781234567890-token-${nonce.slice(2, 14)}`,
);
assert.equal(
  operatorBlindRationale(run.runId),
  "operator-blind release gate ob-1781234567890-token",
);

assert.equal(normalizeOperatorBlindCtHashToHex32(1n, "bin"), hex32("01"));
assert.equal(normalizeOperatorBlindCtHashToHex32(15, "bin"), hex32("0f"));
assert.equal(normalizeOperatorBlindCtHashToHex32("15", "bin"), hex32("0f"));
assert.equal(normalizeOperatorBlindBytesHex("abcd", "bin"), "0xabcd");
assert.throws(
  () => normalizeOperatorBlindBytesHex("abc", "bin"),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "encrypt" &&
    /even-length hex/.test(err.detail),
);

const binHandle = `0x${"11".repeat(32)}`;
const confHandleWithSentinel = `0x${"00".repeat(30)}7531`;
const onchainCallId = `0x${"aa".repeat(32)}`;
const sealedSnapshot = {
  fhenix: {
    [OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS.binaryIndexCtHash]: binHandle,
    [OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS.confidenceCtHash]:
      confHandleWithSentinel,
    [OPERATOR_BLIND_FHENIX_ONCHAIN_CALL_ID_KEY]: onchainCallId,
  },
};
assert.deepEqual(
  assertOperatorBlindSealedSnapshotOpaque({
    snapshot: sealedSnapshot,
    sentinelConfidence: 7531,
  }),
  {
    binaryIndexCtHash: binHandle,
    confidenceCtHash: confHandleWithSentinel,
    onchainCallId,
  },
);
assert.equal(
  findOperatorBlindNumericLeaf({ nested: { confidence: "7531" } }, 7531),
  "$.nested.confidence",
);
assert.throws(
  () =>
    assertOperatorBlindSealedSnapshotOpaque({
      snapshot: {
        fhenix: {
          ...sealedSnapshot.fhenix,
          leaked_confidence_bps: 7531,
        },
      },
      sentinelConfidence: 7531,
    }),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "A1" &&
    /confidence sentinel/.test(err.detail),
);
assert.throws(
  () =>
    assertOperatorBlindSealedSnapshotOpaque({
      snapshot: {
        fhenix: {
          ...sealedSnapshot.fhenix,
          [OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY]: { confidence_bps: 7531 },
        },
      },
      sentinelConfidence: 7531,
    }),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "A1" &&
    /populated pre-reveal/.test(err.detail),
);

assert.doesNotThrow(() =>
  assertOperatorBlindDashboardPreRevealText({
    innerText: "call is fhenix sealed and still operator-blind",
    sentinelConfidence: 7531,
  }),
);
assert.throws(
  () =>
    assertOperatorBlindDashboardPreRevealText({
      innerText: "call is sealed but confidence is 75.31%",
      sentinelConfidence: 7531,
    }),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "A2" &&
    /contains confidence sentinel/.test(err.detail),
);

const revealed = assertOperatorBlindRevealSnapshotPlaintext({
  snapshot: {
    fhenix: {
      [OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY]: {
        [OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.binaryIndex]: 0,
        [OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps]: 7531,
      },
    },
  },
  sentinelBinaryIndex: 0,
  sentinelConfidence: 7531,
  publishTx: `0x${"bb".repeat(32)}`,
});
assert.equal(
  revealed[OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps],
  7531,
);
assert.throws(
  () =>
    assertOperatorBlindRevealSnapshotPlaintext({
      snapshot: {
        fhenix: {
          [OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY]: {
            [OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.binaryIndex]: 0,
            [OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps]: 7000,
          },
        },
      },
      sentinelBinaryIndex: 0,
      sentinelConfidence: 7531,
    }),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "A3" &&
    /confidence_bps/.test(err.detail),
);

assert.deepEqual(
  assertOperatorBlindDashboardPostRevealText({
    innerText: "revealed confidence 75.31%",
    sentinelConfidence: 7531,
  }),
  { hitForm: "75.31%", forms: ["7531", "75.31%"] },
);
assert.throws(
  () =>
    assertOperatorBlindDashboardPostRevealText({
      innerText: "revealed but no confidence yet",
      sentinelConfidence: 7531,
    }),
  (err) =>
    err instanceof OperatorBlindRoundtripError &&
    err.phase === "A3" &&
    /never surfaced/.test(err.detail),
);

process.stdout.write("operator blind roundtrip surface smoke ok\n");

function hex32(lastByteHex: string): string {
  return `0x${"00".repeat(31)}${lastByteHex}`;
}
