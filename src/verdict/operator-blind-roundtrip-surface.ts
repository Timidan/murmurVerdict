import { keccak256, toHex, type Hex } from "viem";

import { OPERATOR_BLIND_FIXTURE_MARKET_ID } from "./operator-blind-fixture-surface.js";

export const OPERATOR_BLIND_ROUNDTRIP_CHAIN_ID = 84532;
export const OPERATOR_BLIND_DEFAULT_MARKET_ID =
  OPERATOR_BLIND_FIXTURE_MARKET_ID as Hex;
export const OPERATOR_BLIND_SENTINEL_CONFIDENCE_MIN = 5100;
export const OPERATOR_BLIND_SENTINEL_CONFIDENCE_MAX = 9500;
export const OPERATOR_BLIND_SENTINEL_BINARY_INDEX = 0;

export const OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS = {
  binaryIndexCtHash: "binary_index_ct_hash",
  confidenceCtHash: "confidence_ct_hash",
} as const;
export const OPERATOR_BLIND_FHENIX_ONCHAIN_CALL_ID_KEY = "onchain_call_id";
export const OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY =
  "revealed_verdict";
export const OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS = {
  binaryIndex: "binary_index",
  confidenceBps: "confidence_bps",
} as const;

export type OperatorBlindRoundtripPhase =
  | "run"
  | "encrypt"
  | "A1"
  | "A2"
  | "A3";

export class OperatorBlindRoundtripError extends Error {
  readonly phase: OperatorBlindRoundtripPhase;
  readonly detail: string;
  readonly excerpt: unknown;

  constructor(
    phase: OperatorBlindRoundtripPhase,
    detail: string,
    excerpt?: unknown,
  ) {
    super(`${phase}: ${detail}`);
    this.name = "OperatorBlindRoundtripError";
    this.phase = phase;
    this.detail = detail;
    this.excerpt = excerpt;
  }
}

export interface OperatorBlindRoundtripRunInput {
  nowMs: () => number;
  newRunToken?: () => string | number;
  newSentinelConfidence?: () => number;
}

export interface OperatorBlindRoundtripRun {
  startedAtMs: number;
  runId: string;
  sentinelConfidence: number;
  sentinelBinaryIndex: typeof OPERATOR_BLIND_SENTINEL_BINARY_INDEX;
}

export interface OperatorBlindSealedSnapshot {
  binaryIndexCtHash: Hex;
  confidenceCtHash: Hex;
  onchainCallId: Hex;
}

export function startOperatorBlindRoundtrip(
  input: OperatorBlindRoundtripRunInput,
): OperatorBlindRoundtripRun {
  const startedAtMs = input.nowMs();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    fail("run", "nowMs must return a safe non-negative integer", startedAtMs);
  }
  const runToken =
    input.newRunToken?.() ?? randomOperatorBlindConfidenceSentinel();
  const sentinelConfidence =
    input.newSentinelConfidence?.() ?? randomOperatorBlindConfidenceSentinel();
  assertOperatorBlindSentinelConfidence(sentinelConfidence, "sentinelConfidence");
  return {
    startedAtMs,
    runId: `ob-${startedAtMs}-${String(runToken)}`,
    sentinelConfidence,
    sentinelBinaryIndex: OPERATOR_BLIND_SENTINEL_BINARY_INDEX,
  };
}

export function randomOperatorBlindConfidenceSentinel(
  random: () => number = Math.random,
): number {
  const lo = OPERATOR_BLIND_SENTINEL_CONFIDENCE_MIN;
  const hi = OPERATOR_BLIND_SENTINEL_CONFIDENCE_MAX;
  const value = random();
  if (typeof value !== "number" || value < 0 || value >= 1) {
    fail("run", "random sentinel Adapter must return a number in [0, 1)", value);
  }
  return lo + Math.floor(value * (hi - lo + 1));
}

export function makeOperatorBlindClientNonce(input: {
  runId: string;
  nonceEntropy?: string | number;
}): Hex {
  const entropy = input.nonceEntropy ?? Math.random();
  return keccak256(toHex(`${input.runId}-nonce-${String(entropy)}`));
}

export function operatorBlindClientOrderId(
  runId: string,
  clientNonce: Hex,
): string {
  return `${runId}-${clientNonce.slice(2, 14)}`;
}

export function operatorBlindRationale(runId: string): string {
  return `operator-blind release gate ${runId}`;
}

export function operatorBlindSentinelTextForms(
  sentinel: number,
): readonly [string, string] {
  assertOperatorBlindSentinelConfidence(sentinel, "sentinel");
  return [`${sentinel}`, `${(sentinel / 100).toFixed(2)}%`];
}

export function findOperatorBlindNumericLeaf(
  value: unknown,
  sentinel: number,
  path = "$",
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return value === sentinel ? path : null;
  }
  if (typeof value === "bigint") {
    return value === BigInt(sentinel) ? path : null;
  }
  if (typeof value === "string") {
    if (/^\d+$/.test(value) && Number(value) === sentinel) {
      return path;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findOperatorBlindNumericLeaf(
        value[i],
        sentinel,
        `${path}[${i}]`,
      );
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findOperatorBlindNumericLeaf(v, sentinel, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}

export function normalizeOperatorBlindCtHashToHex32(
  value: unknown,
  label: string,
): Hex {
  let hex: string;
  if (typeof value === "bigint") {
    hex = value.toString(16);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("encrypt", `${label}.ctHash is not a safe non-negative integer`, value);
    }
    hex = BigInt(value).toString(16);
  } else if (typeof value === "string") {
    hex = value.startsWith("0x") ? value.slice(2) : BigInt(value).toString(16);
  } else {
    fail("encrypt", `${label}.ctHash has unsupported type ${typeof value}`);
  }
  const out = `0x${hex.padStart(64, "0")}`.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(out)) {
    fail("encrypt", `${label}.ctHash did not normalize to bytes32`, {
      value,
      normalized: out,
    });
  }
  return out as Hex;
}

export function normalizeOperatorBlindBytesHex(
  value: unknown,
  label: string,
): Hex {
  if (typeof value !== "string") {
    fail("encrypt", `${label}.signature must be a hex string`, value);
  }
  const out = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(out)) {
    fail("encrypt", `${label}.signature is not even-length hex`, out);
  }
  return out as Hex;
}

export function requireOperatorBlindHex32(
  value: unknown,
  label: string,
): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail("A1", `${label} expected 0x-prefixed bytes32`, value);
  }
  return value.toLowerCase() as Hex;
}

export function assertOperatorBlindSealedSnapshotOpaque(input: {
  snapshot: Record<string, unknown>;
  sentinelConfidence: number;
}): OperatorBlindSealedSnapshot {
  assertOperatorBlindSentinelConfidence(
    input.sentinelConfidence,
    "sentinelConfidence",
  );
  const fhenix = (input.snapshot["fhenix"] ?? null) as
    | Record<string, unknown>
    | null;
  if (!fhenix || typeof fhenix !== "object") {
    fail("A1", "daemon response missing top-level 'fhenix' sub-object", input.snapshot);
  }
  const binHandle = fhenix[OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS.binaryIndexCtHash];
  const confHandle = fhenix[OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS.confidenceCtHash];
  if (typeof binHandle !== "string" || !binHandle.startsWith("0x")) {
    fail(
      "A1",
      `fhenix.${OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS.binaryIndexCtHash} missing or not a 0x-prefixed handle`,
      fhenix,
    );
  }
  if (typeof confHandle !== "string" || !confHandle.startsWith("0x")) {
    fail(
      "A1",
      `fhenix.${OPERATOR_BLIND_FHENIX_SEALED_HANDLE_KEYS.confidenceCtHash} missing or not a 0x-prefixed handle`,
      fhenix,
    );
  }
  const onchainCallId = requireOperatorBlindHex32(
    fhenix[OPERATOR_BLIND_FHENIX_ONCHAIN_CALL_ID_KEY],
    `fhenix.${OPERATOR_BLIND_FHENIX_ONCHAIN_CALL_ID_KEY}`,
  );
  const revealed = fhenix[OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY];
  if (revealed !== undefined && revealed !== null) {
    fail(
      "A1",
      `fhenix.${OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY} populated pre-reveal - operator-blind invariant broken`,
      revealed,
    );
  }
  const preStringified = JSON.stringify(input.snapshot);
  if (preStringified.includes(`${input.sentinelConfidence}`)) {
    const scrubbed = preStringified
      .replaceAll(binHandle, "")
      .replaceAll(confHandle, "");
    if (scrubbed.includes(`${input.sentinelConfidence}`)) {
      fail(
        "A1",
        `JSON.stringify(daemon response) contains confidence sentinel ${input.sentinelConfidence} outside the opaque ctHash handles`,
        preStringified,
      );
    }
  }
  const numericHit = findOperatorBlindNumericLeaf(
    input.snapshot,
    input.sentinelConfidence,
  );
  if (numericHit) {
    fail(
      "A1",
      `deep numeric walk found confidence sentinel ${input.sentinelConfidence} at JSON path ${numericHit}`,
      input.snapshot,
    );
  }
  return {
    binaryIndexCtHash: binHandle as Hex,
    confidenceCtHash: confHandle as Hex,
    onchainCallId,
  };
}

export function assertOperatorBlindDashboardPreRevealText(input: {
  innerText: string;
  sentinelConfidence: number;
}): void {
  if (
    !input.innerText.includes("sealed") &&
    !input.innerText.includes("operator-blind")
  ) {
    fail(
      "A2",
      `dashboard call page is missing the sealed affordance (neither "sealed" nor "operator-blind" found in innerText)`,
      input.innerText.slice(0, 2000),
    );
  }
  const forms = operatorBlindSentinelTextForms(input.sentinelConfidence);
  const leakForm = forms.find((f) => input.innerText.includes(f));
  if (leakForm) {
    const idx = input.innerText.indexOf(leakForm);
    const excerpt = input.innerText.slice(Math.max(0, idx - 200), idx + 200);
    fail(
      "A2",
      `dashboard DOM innerText contains confidence sentinel "${leakForm}" (scanned for both raw=${forms[0]} and percent=${forms[1]})`,
      excerpt,
    );
  }
}

export function assertOperatorBlindRevealSnapshotPlaintext(input: {
  snapshot: Record<string, unknown>;
  sentinelBinaryIndex: number;
  sentinelConfidence: number;
  publishTx?: string;
}): Record<string, unknown> {
  const fhenix = input.snapshot["fhenix"] as Record<string, unknown> | undefined;
  if (!fhenix) {
    fail("A3", "daemon post-publish response missing 'fhenix' sub-object", input.snapshot);
  }
  const revealed = fhenix[OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY] as
    | Record<string, unknown>
    | undefined;
  if (!revealed || typeof revealed !== "object") {
    const tx = input.publishTx ? ` at tx ${input.publishTx}` : "";
    fail(
      "A3",
      `daemon never returned a populated fhenix.${OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY} sub-object after publishReveal landed${tx}`,
      fhenix,
    );
  }
  const revealedBin =
    revealed[OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.binaryIndex];
  const revealedConf =
    revealed[OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps];
  if (revealedBin !== input.sentinelBinaryIndex) {
    fail(
      "A3",
      `expected fhenix.${OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY}.${OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.binaryIndex}=${input.sentinelBinaryIndex}, got ${JSON.stringify(revealedBin)} (keys present: [${Object.keys(revealed).join(", ")}])`,
      revealed,
    );
  }
  if (revealedConf !== input.sentinelConfidence) {
    fail(
      "A3",
      `expected fhenix.${OPERATOR_BLIND_FHENIX_REVEALED_SUBOBJECT_KEY}.${OPERATOR_BLIND_FHENIX_REVEALED_PLAINTEXT_KEYS.confidenceBps}=${input.sentinelConfidence}, got ${JSON.stringify(revealedConf)} (keys present: [${Object.keys(revealed).join(", ")}])`,
      revealed,
    );
  }
  return revealed;
}

export function assertOperatorBlindDashboardPostRevealText(input: {
  innerText: string;
  sentinelConfidence: number;
}): { hitForm: string; forms: readonly [string, string] } {
  const forms = operatorBlindSentinelTextForms(input.sentinelConfidence);
  const hitForm = forms.find((f) => input.innerText.includes(f));
  if (!hitForm) {
    fail(
      "A3",
      `dashboard DOM never surfaced confidence sentinel post-publish; scanned for raw=${forms[0]} and percent=${forms[1]} (innerText excerpt below)`,
      input.innerText.slice(0, 2000),
    );
  }
  return { hitForm, forms };
}

function assertOperatorBlindSentinelConfidence(
  value: number,
  label: string,
): void {
  if (
    !Number.isInteger(value) ||
    value < OPERATOR_BLIND_SENTINEL_CONFIDENCE_MIN ||
    value > OPERATOR_BLIND_SENTINEL_CONFIDENCE_MAX
  ) {
    fail(
      "run",
      `${label} must be an integer in [${OPERATOR_BLIND_SENTINEL_CONFIDENCE_MIN}, ${OPERATOR_BLIND_SENTINEL_CONFIDENCE_MAX}]`,
      value,
    );
  }
}

function fail(
  phase: OperatorBlindRoundtripPhase,
  detail: string,
  excerpt?: unknown,
): never {
  throw new OperatorBlindRoundtripError(phase, detail, excerpt);
}
