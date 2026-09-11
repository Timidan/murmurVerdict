import type { FhenixSealedCallRow } from "./repos/fhenix-sealed-calls-repo.js";

export interface PublicFhenixRevealedVerdict {
  binary_index: number;
  confidence_bps: number;
  confidence: number;
  outcome_label?: string;
}

export interface PublicFhenixRevealEvidence {
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
  reveal_open_at: string;
  reveal_status: string;
  invalid_reason: string | null;
  terminal_at: string | null;
  revealed_at: string | null;
  revealed_verdict?: PublicFhenixRevealedVerdict;
}

export interface PublicFhenixRevealIngestionBody {
  call_id: string;
  privacy_mode: "sealed_fhenix";
  status: "revealed";
  revealed_at: string;
  revealed_verdict: PublicFhenixRevealedVerdict & {
    binary_index: 0 | 1;
    outcome_label: string;
  };
}

export interface PublicFhenixInvalidRevealIngestionBody {
  call_id: string;
  privacy_mode: "sealed_fhenix";
  status: "invalid_reveal";
  invalid_reason: "binary_index" | "confidence" | "unknown";
  revealed_at: string;
  revealed_verdict: {
    binary_index: number;
    confidence_bps: number;
  };
}

export function publicFhenixRevealEvidence(
  sealed: FhenixSealedCallRow | null,
  outcomeLabels?: readonly string[] | null,
): PublicFhenixRevealEvidence | null {
  if (!sealed) return null;
  const revealedBinaryIndex = sealed.revealed_binary_index;
  const revealedConfidenceBps = sealed.revealed_confidence_bps;
  const revealIsPublic =
    (sealed.reveal_status === "revealed" || sealed.reveal_status === "invalid") &&
    sealed.revealed_at !== null &&
    revealedBinaryIndex !== null &&
    revealedConfidenceBps !== null;
  // `outcomeLabelsForMarket` answers `outcome_N` when the venue named nothing;
  // that is not a venue word, so it is dropped rather than forwarded.
  const label =
    revealedBinaryIndex === null ? undefined : outcomeLabels?.[revealedBinaryIndex];
  const outcomeLabel =
    typeof label === "string" &&
    label.length > 0 &&
    label !== `outcome_${revealedBinaryIndex}`
      ? label
      : undefined;
  return {
    chain_id: sealed.chain_id,
    contract_address: sealed.contract_address,
    onchain_call_id: sealed.onchain_call_id,
    binary_index_ct_hash: sealed.binary_index_ct_hash,
    confidence_ct_hash: sealed.confidence_ct_hash,
    reveal_open_at: sealed.reveal_open_at,
    reveal_status: sealed.reveal_status,
    invalid_reason: sealed.invalid_reason,
    terminal_at: sealed.terminal_at,
    revealed_at: sealed.revealed_at,
    ...(revealIsPublic
      ? {
          revealed_verdict: {
            binary_index: revealedBinaryIndex,
            confidence_bps: revealedConfidenceBps,
            confidence: fhenixRevealConfidence(
              sealed.revealed_confidence,
              revealedConfidenceBps,
            ),
            ...(outcomeLabel ? { outcome_label: outcomeLabel } : {}),
          },
        }
      : {}),
  };
}

export function publicFhenixRevealIngestionBody(input: {
  call_id: string;
  binary_index: 0 | 1;
  confidence_bps: number;
  revealed_at: string;
  outcomeLabels: string[];
}): PublicFhenixRevealIngestionBody {
  return {
    call_id: input.call_id,
    privacy_mode: "sealed_fhenix",
    status: "revealed",
    revealed_at: input.revealed_at,
    revealed_verdict: {
      binary_index: input.binary_index,
      outcome_label: input.outcomeLabels[input.binary_index] ??
        `outcome_${input.binary_index}`,
      confidence_bps: input.confidence_bps,
      confidence: fhenixRevealConfidence(null, input.confidence_bps),
    },
  };
}

export function publicFhenixInvalidRevealIngestionBody(input: {
  call_id: string;
  binary_index: number;
  confidence_bps: number;
  invalid_reason: "binary_index" | "confidence" | "unknown";
  revealed_at: string;
}): PublicFhenixInvalidRevealIngestionBody {
  return {
    call_id: input.call_id,
    privacy_mode: "sealed_fhenix",
    status: "invalid_reveal",
    invalid_reason: input.invalid_reason,
    revealed_at: input.revealed_at,
    revealed_verdict: {
      binary_index: input.binary_index,
      confidence_bps: input.confidence_bps,
    },
  };
}

export function fhenixRevealConfidence(
  value: number | null,
  bps: number | null,
): number {
  return value ?? (bps ?? 0) / 10_000;
}
