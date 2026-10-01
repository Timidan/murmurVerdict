import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from "viem";

import type { NanopayReceiptRow } from "./repos/nanopay-receipts-repo.js";

/**
 * Nanopayments binding helpers: the EIP-712 request signal id, the Fhenix
 * anchor tuple, and (de)serialization for `nanopay_receipts.binding_json`.
 */

/**
 * `chainId` + `verifyingContract` scope the digest to one sealed-verdicts
 * deployment, so a sig can't be replayed across chains.
 */
export interface DomainParams {
  /** Sealed-Fhenix anchor chain, e.g. 421614 (Arbitrum Sepolia). */
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
 * EIP-712 digest for a per-call request signal id; stored as
 * `nanopay_receipts.request_signal_id`. `buyer` is recovered from the
 * EIP-3009 signature.
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
  const digest = keccak256(
    `0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as `0x${string}`,
  );
  return digest;
}

/**
 * Fhenix anchor embedded in the Nanopayments binding, so callers can verify
 * the served signal is a real sealed call whose commit hash matches
 * `MurmurSealedVerdicts` at the same submit tx + log.
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
  /** e.g. "fhenix-sealed-v1". */
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

export function bindingFromReceipt(row: NanopayReceiptRow): NanopayBinding {
  return parseBinding(row.binding_json);
}

/**
 * Present once `revealOpenAt <= now`, null before. Kept `unknown` so this
 * module avoids reveal-decoding deps; the route handler builds it.
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
