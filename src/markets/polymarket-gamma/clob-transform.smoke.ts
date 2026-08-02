import { strict as assert } from "node:assert";

import type { ClobMarketSnapshot } from "./clob-client.js";
import {
  clobMarketToOutcome,
  normalizeOutcomeLabel,
  CLOB_SOURCE_PROTOCOL,
} from "./clob-transform.js";

process.stdout.write("murmur Polymarket CLOB transform smoke\n");

const conditionId = `0x${"ab".repeat(32)}`;
const endDate = "2026-07-18T21:50:00Z";

const baseSnapshot: ClobMarketSnapshot = {
  condition_id: conditionId,
  question: "Bitcoin Up or Down - July 18, 9:45PM-9:50PM ET",
  closed: true,
  archived: false,
  accepting_orders: false,
  end_date_iso: endDate,
  is_50_50_outcome: false,
  tokens: [
    { token_id: "111", outcome: "Up", price: 0, winner: false },
    { token_id: "222", outcome: "Down", price: 1, winner: true },
  ],
};

const baseInput = {
  conditionId,
  storedOutcomes: ["Up", "Down"] as const,
  endDate,
  snapshot: baseSnapshot,
};

assert.equal(normalizeOutcomeLabel("  DoWn "), "down");

// ── happy path: one winner, full label bijection, one-hot vector ──
{
  const mapped = clobMarketToOutcome(baseInput);
  assert.equal(mapped.kind, "outcome");
  if (mapped.kind !== "outcome") throw new Error("unreachable");
  assert.equal(mapped.outcome.kind, "binary");
  assert.deepEqual(mapped.outcome.payoutNumerators, [0n, 1n]);
  assert.equal(mapped.outcome.payoutDenominator, 1n);
  assert.equal(mapped.outcome.resolvedAt, Math.floor(Date.parse(endDate) / 1000));
  assert.equal(mapped.outcome.evidence.sourceProtocol, CLOB_SOURCE_PROTOCOL);
  assert.equal(mapped.outcome.evidence.sourceId, conditionId);
  assert.equal(mapped.outcome.evidence.raw, baseSnapshot);
}

// ── reordered tokens + case variation still align to STORED order ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    snapshot: {
      ...baseSnapshot,
      tokens: [
        { token_id: "222", outcome: " DOWN", price: 0, winner: false },
        { token_id: "111", outcome: "uP ", price: 1, winner: true },
      ],
    },
  });
  assert.equal(mapped.kind, "outcome");
  if (mapped.kind !== "outcome") throw new Error("unreachable");
  assert.deepEqual(mapped.outcome.payoutNumerators, [1n, 0n]); // Up wins
}

// ── condition mismatch fails closed ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    conditionId: `0x${"cd".repeat(32)}`,
  });
  assert.deepEqual(mapped, { kind: "pending", error: "condition_id_mismatch" });
}

// ── open market → pending, no error ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    snapshot: { ...baseSnapshot, closed: false },
  });
  assert.deepEqual(mapped, { kind: "pending", error: null });
}

// ── zero winners (UMA not sealed) → pending, no error ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    snapshot: {
      ...baseSnapshot,
      tokens: [
        { token_id: "111", outcome: "Up", price: 0.4, winner: false },
        { token_id: "222", outcome: "Down", price: 0.6, winner: false },
      ],
    },
  });
  assert.deepEqual(mapped, { kind: "pending", error: null });
}

// ── multiple winners → pending + inconsistent-schema error ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    snapshot: {
      ...baseSnapshot,
      tokens: [
        { token_id: "111", outcome: "Up", price: 1, winner: true },
        { token_id: "222", outcome: "Down", price: 1, winner: true },
      ],
    },
  });
  assert.deepEqual(mapped, { kind: "pending", error: "multiple_winners" });
}

// ── winner/loser prices inconsistent with 1/0 → pending + error ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    snapshot: {
      ...baseSnapshot,
      tokens: [
        { token_id: "111", outcome: "Up", price: 0.2, winner: false },
        { token_id: "222", outcome: "Down", price: 0.8, winner: true },
      ],
    },
  });
  assert.deepEqual(mapped, {
    kind: "pending",
    error: "price_winner_inconsistent",
  });
}

// ── archived + 50/50 are held pending (never invalid) this release ──
{
  const archived = clobMarketToOutcome({
    ...baseInput,
    snapshot: { ...baseSnapshot, archived: true },
  });
  assert.deepEqual(archived, { kind: "pending", error: "archived_held_pending" });
  const fiftyFifty = clobMarketToOutcome({
    ...baseInput,
    snapshot: { ...baseSnapshot, is_50_50_outcome: true },
  });
  assert.deepEqual(fiftyFifty, {
    kind: "pending",
    error: "is_50_50_held_pending",
  });
}

// ── NO semantic aliasing: Yes/No stored vs Up/Down CLOB fails closed ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    storedOutcomes: ["Yes", "No"],
  });
  assert.deepEqual(mapped, { kind: "pending", error: "label_bijection_failed" });
}

// ── duplicate labels on either side fail closed ──
{
  const storedDupes = clobMarketToOutcome({
    ...baseInput,
    storedOutcomes: ["Up", "UP "],
  });
  assert.deepEqual(storedDupes, {
    kind: "pending",
    error: "stored_labels_not_unique",
  });
  const clobDupes = clobMarketToOutcome({
    ...baseInput,
    snapshot: {
      ...baseSnapshot,
      tokens: [
        { token_id: "111", outcome: "Up", price: 0, winner: false },
        { token_id: "222", outcome: " UP", price: 1, winner: true },
      ],
    },
  });
  assert.deepEqual(clobDupes, {
    kind: "pending",
    error: "clob_labels_not_unique",
  });
}

// ── stored token-ID map is preferred over labels, and fails closed ──
{
  const byTokenId = clobMarketToOutcome({
    ...baseInput,
    storedClobTokenIds: { up: "111", down: "222" },
    snapshot: {
      ...baseSnapshot,
      tokens: [
        // Labels drifted server-side — token identity still resolves.
        { token_id: "222", outcome: "Lower", price: 1, winner: true },
        { token_id: "111", outcome: "Higher", price: 0, winner: false },
      ],
    },
  });
  assert.equal(byTokenId.kind, "outcome");
  if (byTokenId.kind !== "outcome") throw new Error("unreachable");
  assert.deepEqual(byTokenId.outcome.payoutNumerators, [0n, 1n]); // Down wins
  const idMismatch = clobMarketToOutcome({
    ...baseInput,
    storedClobTokenIds: { up: "999", down: "888" },
  });
  assert.deepEqual(idMismatch, { kind: "pending", error: "token_id_mismatch" });
}

// ── duplicate token ids → pending + error ──
{
  const mapped = clobMarketToOutcome({
    ...baseInput,
    snapshot: {
      ...baseSnapshot,
      tokens: [
        { token_id: "111", outcome: "Up", price: 0, winner: false },
        { token_id: "111", outcome: "Down", price: 1, winner: true },
      ],
    },
  });
  assert.deepEqual(mapped, { kind: "pending", error: "duplicate_token_id" });
}

// ── missing/invalid stored endDate → pending (no resolvedAt to sign) ──
{
  const mapped = clobMarketToOutcome({ ...baseInput, endDate: null });
  assert.deepEqual(mapped, { kind: "pending", error: "missing_end_date" });
}

process.stdout.write("Polymarket CLOB transform smoke ok\n");
