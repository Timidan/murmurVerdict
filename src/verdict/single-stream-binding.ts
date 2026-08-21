import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from "viem";

import type { NanopayReceiptRow } from "./repos/nanopay-receipts-repo.js";

/**
 * Wave L.A — Single-stream invariant binding helpers.
 *
 * Provides:
 *   1. `computeRequestSignalId`: EIP-712 typed-data hash that
 *      deterministically identifies a per-call signal across the
 *      Nanopayments rail. Domain-separated by chainId +
 *      verifyingContract (sealed-Fhenix anchor), so cross-rail and
 *      cross-chain replay are not possible.
 *
 *   2. `FhenixAnchorTuple`: the full anchor data structure embedded
 *      in the response payload, letting callers independently verify
 *      the served signal == sealed-Fhenix-anchored signal.
 *
 *   3. `serializeBinding` / `parseBinding`: persistence helpers used
 *      by `nanopay_receipts.binding_json`.
 *
 * Design note: docs/superpowers/specs/2026-05-23-wave-l-a-nanopayments-design.md
 *
 * EIP-712 reference: https://eips.ethereum.org/EIPS/eip-712
 */

/**
 * Domain separator parameters. Stable across deploy environments — the
 * `chainId` + `verifyingContract` fields scope the digest to a specific
 * sealed-verdicts deployment, so a sig generated for Base Sepolia can
 * not be replayed against Base mainnet (or vice-versa).
 */
export interface DomainParams {
  /** Sealed-Fhenix anchor chain. For Phase 1: 84532 (Base Sepolia). */
  readonly chainId: number;
  /** Sealed-verdicts contract address on `chainId`. */
  readonly verifyingContract: `0x${string}`;
}

/**
 * EIP-712 domain typehash:
 *   keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
 */
const EIP712_DOMAIN_TYPEHASH =
  "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f";

/**
 * RequestSignalId typehash:
 *   keccak256("RequestSignalId(bytes32 pipelineId,address buyer,bytes32 eip3009Nonce)")
 *
 * Computed once at module load; reviewers can recompute via
 *   `cast keccak "RequestSignalId(bytes32 pipelineId,address buyer,bytes32 eip3009Nonce)"`
 * to confirm.
 */
const REQUEST_SIGNAL_ID_TYPEHASH = keccak256(
  toHex("RequestSignalId(bytes32 pipelineId,address buyer,bytes32 eip3009Nonce)"),
);

const DOMAIN_NAME_HASH = keccak256(toHex("MurmurNanopay"));
const DOMAIN_VERSION_HASH = keccak256(toHex("1"));

/**
 * Compute the EIP-712 domain separator for the given chain + contract.
 *   keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(name), keccak256(version), chainId, verifyingContract))
 */
export function computeDomainSeparator(domain: DomainParams): `0x${string}` {
  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
    [
      EIP712_DOMAIN_TYPEHASH as `0x${string}`,
      DOMAIN_NAME_HASH,
      DOMAIN_VERSION_HASH,
      BigInt(domain.chainId),
      domain.verifyingContract,
    ],
  );
  return keccak256(encoded);
}

/**
 * Compute the EIP-712 typed-data hash for a per-call request signal id.
 *
 * Inputs:
 *   - pipelineId: 32-byte hex identifying the pipeline being consumed.
 *   - buyer: payer address (recovered from the EIP-3009 signature).
 *   - eip3009Nonce: 32-byte hex nonce from the EIP-3009 authorization.
 *   - domain: chainId + verifyingContract (sealed-Fhenix anchor).
 *
 * Output: 32-byte hex digest. Deterministic — same inputs always
 * produce the same digest. Used as the `request_signal_id` column in
 * `nanopay_receipts` and as the `requestSignalId` binding field.
 *
 * Implementation follows the EIP-712 spec:
 *   structHash = keccak256(abi.encode(REQUEST_SIGNAL_ID_TYPEHASH, pipelineId, buyer, eip3009Nonce))
 *   digest = keccak256(0x1901 || domainSeparator || structHash)
 */
export function computeRequestSignalId(input: {
  pipelineId: `0x${string}`;
  buyer: `0x${string}`;
  eip3009Nonce: `0x${string}`;
  domain: DomainParams;
}): `0x${string}` {
  const structHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32, bytes32, address, bytes32"),
      [
        REQUEST_SIGNAL_ID_TYPEHASH,
        input.pipelineId,
        input.buyer,
        input.eip3009Nonce,
      ],
    ),
  );
  const domainSeparator = computeDomainSeparator(input.domain);
  // 0x1901 || domainSeparator || structHash, then keccak256.
  const digest = keccak256(
    `0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as `0x${string}`,
  );
  return digest;
}

/**
 * Full Fhenix anchor tuple as embedded in the Nanopayments response
 * binding. Lets the caller independently verify:
 *   1. The served signal corresponds to a real sealed-Fhenix call.
 *   2. The commit hash matches what `MurmurSealedVerdicts` has stored
 *      at the same submit-tx + log.
 *   3. If `revealOpenAt` <= now, the `reveal_artifact` (carried
 *      separately in the response) is the canonical reveal.
 *
 * Schema version `1` so future evolutions (adding fields, switching
 * commit schemes) can be detected by clients.
 */
export interface FhenixAnchorTuple {
  readonly bindingVersion: 1;
  readonly chainId: number;
  readonly sealedVerdictsContractAddress: `0x${string}`;
  /** Per-call id assigned by `MurmurSealedVerdicts` on submit. */
  readonly onchainCallId: `0x${string}`;
  readonly marketId: string;
  readonly agent: `0x${string}`;
  readonly submitTxHash: `0x${string}`;
  readonly submitLogIndex: number;
  /** keccak256(ciphertext) for the binary-index field. */
  readonly binaryIndexCiphertextHash: `0x${string}`;
  /** keccak256(ciphertext) for the confidence field. */
  readonly confidenceCiphertextHash: `0x${string}`;
  /** ISO-8601 timestamp when the sealed-Fhenix horizon opens. */
  readonly revealOpenAt: string;
  /** e.g. "fhenix-sealed-v1" — see sealed-call-acceptance.ts. */
  readonly commitScheme: string;
  /** keccak/sha256 commit-hash for cross-check with on-chain emit. */
  readonly commitHash: string;
}

/**
 * The full binding payload returned in the Nanopayments response and
 * persisted in `nanopay_receipts.binding_json`.
 */
export interface NanopayBinding {
  readonly pipelineId: `0x${string}`;
  readonly buyerAddress: `0x${string}`;
  readonly requestSignalId: `0x${string}`;
  readonly eip3009Nonce: `0x${string}`;
  /** Circle Gateway settlement UUID (null when binding is captured pre-settle). */
  readonly circleTransactionUuid: string | null;
  readonly anchor: FhenixAnchorTuple;
}

export function serializeBinding(binding: NanopayBinding): string {
  return JSON.stringify(binding);
}

export function parseBinding(json: string): NanopayBinding {
  return JSON.parse(json) as NanopayBinding;
}

/**
 * Re-export of the persisted-row's binding accessor. Convenience for
 * callers who hold a `NanopayReceiptRow` and want the parsed binding
 * without re-resolving from a column name.
 */
export function bindingFromReceipt(row: NanopayReceiptRow): NanopayBinding {
  return parseBinding(row.binding_json);
}

/**
 * The reveal artifact, present once `revealOpenAt <= now`. Pre-reveal
 * responses carry `revealArtifact: null` and clients can poll until
 * the horizon opens.
 *
 * The artifact shape mirrors what the existing daemon's
 * sealed-call reveal pipeline produces. We keep it as `unknown` here
 * so this helper module stays free of the wider reveal-decoding
 * dependency surface; the route handler does the structured assembly.
 */
export type RevealArtifact = unknown;

export function serializeRevealArtifact(artifact: RevealArtifact | null): string | null {
  if (artifact === null) return null;
  return JSON.stringify(artifact);
}

export function parseRevealArtifact(json: string | null): RevealArtifact | null {
  if (json === null) return null;
  return JSON.parse(json) as RevealArtifact;
}

export function revealArtifactFromReceipt(row: NanopayReceiptRow): RevealArtifact | null {
  return parseRevealArtifact(row.reveal_artifact_json);
}
