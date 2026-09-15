import {
  decodeEventLog,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbiItem,
  toBytes,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";

// ── Murmur Sealed Verdicts submit-event source of truth ─────────────────────
// The single declaration of the submit events; the gateway ABI, reconciliation
// and smokes all derive from these. Must match contracts/src/MurmurSealedVerdicts.sol.
export const SEALED_CALL_SUBMITTED_EVENT = parseAbiItem(
  "event SealedCallSubmitted(bytes32 indexed callId,address indexed agent,bytes32 indexed marketId,uint64 acceptedAt,uint64 publicRevealAt,bytes32 binaryIndexCtHash,bytes32 confidenceCtHash,bytes32 clientNonce,uint8 submissionClass)",
);

export const FEED_PACKET_SUBMITTED_EVENT = parseAbiItem(
  "event FeedPacketSubmitted(bytes32 indexed packetId,address indexed agent,bytes32 indexed feedId,bytes32 marketId,uint64 acceptedAt,uint64 revealAfter,bytes32 actionCtHash,bytes32 signalCtHash,bytes32 clientNonce)",
);

// Derived topic0 selectors (keccak of the canonical event signature).
export const SEALED_CALL_SUBMITTED_TOPIC: Hex = toEventSelector(
  SEALED_CALL_SUBMITTED_EVENT,
);
export const FEED_PACKET_SUBMITTED_TOPIC: Hex = toEventSelector(
  FEED_PACKET_SUBMITTED_EVENT,
);

export const VERDICT_REVEALED_EVENT = parseAbiItem(
  "event VerdictRevealed(bytes32 indexed callId,address indexed agent,bytes32 indexed marketId,uint8 binaryIndex,uint16 confidenceBps,uint64 revealedAt)",
);

export const VERDICT_REVEAL_INVALID_EVENT = parseAbiItem(
  "event VerdictRevealInvalid(bytes32 indexed callId,address indexed agent,bytes32 indexed marketId,uint8 binaryIndex,uint16 confidenceBps,uint8 reason,uint64 revealedAt)",
);

export type ReceiptLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number;
  blockNumber?: bigint;
  blockHash?: Hex;
  transactionHash?: Hex;
};

export type ReceiptClient = {
  getChainId: () => Promise<number>;
  getTransactionReceipt: (
    args: { hash: Hex },
  ) => Promise<{ logs: readonly ReceiptLog[]; from?: Address }>;
};

export type FhenixVerificationErrorKind =
  | "not_configured"
  | "chain_mismatch"
  | "rpc_failure"
  | "log_not_found"
  | "event_mismatch";

export class FhenixEventVerificationError extends Error {
  constructor(
    message: string,
    public readonly kind: FhenixVerificationErrorKind,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FhenixEventVerificationError";
  }
}

export interface FhenixSealedCallSubmitMetadata {
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  binary_index_ct_hash: string;
  confidence_ct_hash: string;
  accepted_at: string;
  /**
   * When the sealed value becomes public (resolution + series embargo); the contract's
   * `publicRevealAt`. Not the sale close: sales close earlier, at submissionCloseAt.
   */
  reveal_open_at: string;
}

export interface FhenixRevealMetadata {
  reveal_tx_hash: string;
  reveal_log_index: number;
  binary_index: 0 | 1;
  confidence_bps: number;
  revealed_at: string;
}

export interface FhenixInvalidRevealMetadata {
  reveal_tx_hash: string;
  reveal_log_index: number;
  binary_index: number;
  confidence_bps: number;
  invalid_reason: "binary_index" | "confidence" | "unknown";
  revealed_at: string;
}

export interface VerifySealedCallSubmittedInput extends FhenixSealedCallSubmitMetadata {
  expected_agent_wallet: string;
  expected_market_id: string;
}

export interface VerifyVerdictRevealedInput extends FhenixRevealMetadata {
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  expected_agent_wallet: string;
  expected_market_id: string;
}

export interface VerifyVerdictRevealInvalidInput extends FhenixInvalidRevealMetadata {
  chain_id: number;
  contract_address: string;
  onchain_call_id: string;
  expected_agent_wallet: string;
  expected_market_id: string;
}

export interface VerifiedSealedCallSubmitted extends FhenixSealedCallSubmitMetadata {
  /**
   * On-chain SubmissionClass, decoded from the submit event: 1 = EarlyAccess (sellable),
   * 2 = LateUnsellable (scored, never granted). Verification output only, never caller input.
   */
  submission_class: number;
  agent_wallet: string;
  market_id_hash: string;
  client_nonce: string;
}

export interface VerifiedVerdictRevealed extends FhenixRevealMetadata {
  agent_wallet: string;
  market_id_hash: string;
  onchain_call_id: string;
  /** Publish tx `from` (lowercased) — authoritative reveal-attribution sender.
   *  null only when the RPC receipt omits it. */
  reveal_sender: string | null;
}

export interface VerifiedVerdictRevealInvalid extends FhenixInvalidRevealMetadata {
  agent_wallet: string;
  market_id_hash: string;
  onchain_call_id: string;
  /** Publish tx `from` (lowercased) — authoritative reveal-attribution sender.
   *  null only when the RPC receipt omits it. */
  reveal_sender: string | null;
}

export function fhenixMarketIdForMurmurMarket(marketId: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    return marketId.toLowerCase();
  }
  return keccak256(toBytes(marketId)).toLowerCase();
}

export function decodeExpectedEvent(
  log: ReceiptLog,
  eventAbi:
    | typeof SEALED_CALL_SUBMITTED_EVENT
    | typeof VERDICT_REVEALED_EVENT
    | typeof VERDICT_REVEAL_INVALID_EVENT,
  eventName: "SealedCallSubmitted" | "VerdictRevealed" | "VerdictRevealInvalid",
): { args: unknown } {
  try {
    const decoded = decodeEventLog({
      abi: [eventAbi],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    if (decoded.eventName !== eventName) {
      throw new Error(`decoded ${decoded.eventName}`);
    }
    return { args: decoded.args };
  } catch (err) {
    throw new FhenixEventVerificationError(
      `Fhenix log is not ${eventName}`,
      "event_mismatch",
      { error: errorMessage(err) },
    );
  }
}

export function normalizeAllowedContracts(config: {
  contractAddress?: string;
  contractAddresses?: string[];
}): Set<string> {
  const values = [
    ...(config.contractAddresses ?? []),
    ...(config.contractAddress ? [config.contractAddress] : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeAddress);
  return new Set(values);
}

export function invalidRevealReason(value: number): "binary_index" | "confidence" | "unknown" {
  if (value === 1) return "binary_index";
  if (value === 2) return "confidence";
  return "unknown";
}

export function normalizeAddress(value: string): string {
  return getAddress(value as Address).toLowerCase();
}

export function assertSameAddress(actual: string, expected: string, field: string): void {
  if (!isAddressEqual(getAddress(actual as Address), getAddress(expected as Address))) {
    throw mismatch(field, normalizeAddress(expected), normalizeAddress(actual));
  }
}

export function assertSameHex(actual: string, expected: string, field: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw mismatch(field, expected.toLowerCase(), actual.toLowerCase());
  }
}

export function assertSameIsoSecond(actual: string, expected: string, field: string): void {
  const actualMs = Date.parse(actual);
  const expectedMs = Date.parse(expected);
  if (!Number.isFinite(actualMs) || !Number.isFinite(expectedMs) || actualMs !== expectedMs) {
    throw mismatch(field, expected, actual);
  }
}

export function unixSecondsToIso(value: bigint): string {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new FhenixEventVerificationError(
      "Fhenix event timestamp is outside safe JavaScript range",
      "event_mismatch",
      { value: value.toString() },
    );
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

export function lowerHex(value: string): string {
  return value.toLowerCase();
}

export function mismatch(
  field: string,
  expected: unknown,
  actual: unknown,
): FhenixEventVerificationError {
  return new FhenixEventVerificationError(
    `Fhenix event ${field} mismatch`,
    "event_mismatch",
    { field, expected, actual },
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
