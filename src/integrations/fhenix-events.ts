import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbiItem,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { resolveFhenixContractAddress } from "./deployments.js";

export const SEALED_CALL_SUBMITTED_EVENT = parseAbiItem(
  "event SealedCallSubmitted(bytes32 indexed callId,address indexed agent,bytes32 indexed marketId,uint64 acceptedAt,uint64 revealOpenAt,bytes32 binaryIndexCtHash,bytes32 confidenceCtHash,bytes32 clientNonce)",
);

export const FEED_PACKET_SUBMITTED_EVENT = parseAbiItem(
  "event FeedPacketSubmitted(bytes32 indexed packetId,address indexed agent,bytes32 indexed feedId,bytes32 marketId,uint64 acceptedAt,uint64 revealAfter,bytes32 actionCtHash,bytes32 signalCtHash,bytes32 clientNonce)",
);

export const VERDICT_REVEALED_EVENT = parseAbiItem(
  "event VerdictRevealed(bytes32 indexed callId,address indexed agent,bytes32 indexed marketId,uint8 binaryIndex,uint16 confidenceBps,uint64 revealedAt)",
);

export const VERDICT_REVEAL_INVALID_EVENT = parseAbiItem(
  "event VerdictRevealInvalid(bytes32 indexed callId,address indexed agent,bytes32 indexed marketId,uint8 binaryIndex,uint16 confidenceBps,uint8 reason,uint64 revealedAt)",
);

type ReceiptLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number;
  blockNumber?: bigint;
  blockHash?: Hex;
  transactionHash?: Hex;
};

type ReceiptClient = {
  getChainId: () => Promise<number>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ logs: readonly ReceiptLog[] }>;
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
  agent_wallet: string;
  market_id_hash: string;
  client_nonce: string;
}

export interface VerifiedVerdictRevealed extends FhenixRevealMetadata {
  agent_wallet: string;
  market_id_hash: string;
  onchain_call_id: string;
}

export interface VerifiedVerdictRevealInvalid extends FhenixInvalidRevealMetadata {
  agent_wallet: string;
  market_id_hash: string;
  onchain_call_id: string;
}

export interface FhenixEventVerifier {
  verifySealedCallSubmitted(
    input: VerifySealedCallSubmittedInput,
  ): Promise<VerifiedSealedCallSubmitted>;
  verifyVerdictRevealed(
    input: VerifyVerdictRevealedInput,
  ): Promise<VerifiedVerdictRevealed>;
  verifyVerdictRevealInvalid(
    input: VerifyVerdictRevealInvalidInput,
  ): Promise<VerifiedVerdictRevealInvalid>;
}

export interface ViemFhenixEventVerifierConfig {
  rpcUrl: string;
  chainId?: number;
  contractAddress?: string;
  contractAddresses?: string[];
  client?: ReceiptClient;
}

export class ViemFhenixEventVerifier implements FhenixEventVerifier {
  private readonly client: ReceiptClient;
  private readonly chainId: number | null;
  private readonly allowedContracts: Set<string>;

  constructor(config: ViemFhenixEventVerifierConfig) {
    if (!config.client && config.rpcUrl.trim().length === 0) {
      throw new FhenixEventVerificationError(
        "FHENIX_RPC_URL is required for Fhenix event verification",
        "not_configured",
      );
    }
    this.chainId = config.chainId ?? null;
    this.allowedContracts = normalizeAllowedContracts(config);
    if (this.allowedContracts.size === 0) {
      throw new FhenixEventVerificationError(
        "Fhenix event verifier requires at least one allowlisted contract address",
        "not_configured",
      );
    }
    this.client =
      config.client ??
      (createPublicClient({
        transport: http(config.rpcUrl),
      }) as unknown as ReceiptClient);
  }

  async verifySealedCallSubmitted(
    input: VerifySealedCallSubmittedInput,
  ): Promise<VerifiedSealedCallSubmitted> {
    await this.assertChain(input.chain_id);
    this.assertAllowedContract(input.contract_address);
    const log = await this.readLog({
      tx_hash: input.submit_tx_hash,
      log_index: input.submit_log_index,
      contract_address: input.contract_address,
    });
    const decoded = decodeExpectedEvent(log, SEALED_CALL_SUBMITTED_EVENT, "SealedCallSubmitted");
    const args = decoded.args as {
      callId: Hex;
      agent: Address;
      marketId: Hex;
      acceptedAt: bigint;
      revealOpenAt: bigint;
      binaryIndexCtHash: Hex;
      confidenceCtHash: Hex;
      clientNonce: Hex;
    };

    const expectedMarketIdHash = fhenixMarketIdForMurmurMarket(input.expected_market_id);
    const verified: VerifiedSealedCallSubmitted = {
      chain_id: input.chain_id,
      contract_address: normalizeAddress(input.contract_address),
      onchain_call_id: lowerHex(args.callId),
      submit_tx_hash: lowerHex(input.submit_tx_hash),
      submit_log_index: input.submit_log_index,
      binary_index_ct_hash: lowerHex(args.binaryIndexCtHash),
      confidence_ct_hash: lowerHex(args.confidenceCtHash),
      accepted_at: unixSecondsToIso(args.acceptedAt),
      reveal_open_at: unixSecondsToIso(args.revealOpenAt),
      agent_wallet: normalizeAddress(args.agent),
      market_id_hash: lowerHex(args.marketId),
      client_nonce: lowerHex(args.clientNonce),
    };

    assertSameHex(verified.onchain_call_id, input.onchain_call_id, "onchain_call_id");
    assertSameAddress(verified.agent_wallet, input.expected_agent_wallet, "agent");
    assertSameHex(verified.market_id_hash, expectedMarketIdHash, "market_id");
    assertSameHex(verified.binary_index_ct_hash, input.binary_index_ct_hash, "binary_index_ct_hash");
    assertSameHex(verified.confidence_ct_hash, input.confidence_ct_hash, "confidence_ct_hash");
    assertSameIsoSecond(verified.accepted_at, input.accepted_at, "accepted_at");
    assertSameIsoSecond(verified.reveal_open_at, input.reveal_open_at, "reveal_open_at");
    return verified;
  }

  async verifyVerdictRevealed(
    input: VerifyVerdictRevealedInput,
  ): Promise<VerifiedVerdictRevealed> {
    await this.assertChain(input.chain_id);
    this.assertAllowedContract(input.contract_address);
    const log = await this.readLog({
      tx_hash: input.reveal_tx_hash,
      log_index: input.reveal_log_index,
      contract_address: input.contract_address,
    });
    const decoded = decodeExpectedEvent(log, VERDICT_REVEALED_EVENT, "VerdictRevealed");
    const args = decoded.args as {
      callId: Hex;
      agent: Address;
      marketId: Hex;
      binaryIndex: number;
      confidenceBps: number;
      revealedAt: bigint;
    };

    const expectedMarketIdHash = fhenixMarketIdForMurmurMarket(input.expected_market_id);
    const verified: VerifiedVerdictRevealed = {
      reveal_tx_hash: lowerHex(input.reveal_tx_hash),
      reveal_log_index: input.reveal_log_index,
      binary_index: args.binaryIndex as 0 | 1,
      confidence_bps: args.confidenceBps,
      revealed_at: unixSecondsToIso(args.revealedAt),
      agent_wallet: normalizeAddress(args.agent),
      market_id_hash: lowerHex(args.marketId),
      onchain_call_id: lowerHex(args.callId),
    };

    assertSameHex(verified.onchain_call_id, input.onchain_call_id, "onchain_call_id");
    assertSameAddress(verified.agent_wallet, input.expected_agent_wallet, "agent");
    assertSameHex(verified.market_id_hash, expectedMarketIdHash, "market_id");
    if (verified.binary_index !== input.binary_index) {
      throw mismatch("binary_index", input.binary_index, verified.binary_index);
    }
    if (verified.confidence_bps !== input.confidence_bps) {
      throw mismatch("confidence_bps", input.confidence_bps, verified.confidence_bps);
    }
    assertSameIsoSecond(verified.revealed_at, input.revealed_at, "revealed_at");
    return verified;
  }

  async verifyVerdictRevealInvalid(
    input: VerifyVerdictRevealInvalidInput,
  ): Promise<VerifiedVerdictRevealInvalid> {
    await this.assertChain(input.chain_id);
    this.assertAllowedContract(input.contract_address);
    const log = await this.readLog({
      tx_hash: input.reveal_tx_hash,
      log_index: input.reveal_log_index,
      contract_address: input.contract_address,
    });
    const decoded = decodeExpectedEvent(log, VERDICT_REVEAL_INVALID_EVENT, "VerdictRevealInvalid");
    const args = decoded.args as {
      callId: Hex;
      agent: Address;
      marketId: Hex;
      binaryIndex: number;
      confidenceBps: number;
      reason: number;
      revealedAt: bigint;
    };

    const expectedMarketIdHash = fhenixMarketIdForMurmurMarket(input.expected_market_id);
    const verified: VerifiedVerdictRevealInvalid = {
      reveal_tx_hash: lowerHex(input.reveal_tx_hash),
      reveal_log_index: input.reveal_log_index,
      binary_index: args.binaryIndex,
      confidence_bps: args.confidenceBps,
      invalid_reason: invalidRevealReason(args.reason),
      revealed_at: unixSecondsToIso(args.revealedAt),
      agent_wallet: normalizeAddress(args.agent),
      market_id_hash: lowerHex(args.marketId),
      onchain_call_id: lowerHex(args.callId),
    };

    assertSameHex(verified.onchain_call_id, input.onchain_call_id, "onchain_call_id");
    assertSameAddress(verified.agent_wallet, input.expected_agent_wallet, "agent");
    assertSameHex(verified.market_id_hash, expectedMarketIdHash, "market_id");
    if (verified.binary_index !== input.binary_index) {
      throw mismatch("binary_index", input.binary_index, verified.binary_index);
    }
    if (verified.confidence_bps !== input.confidence_bps) {
      throw mismatch("confidence_bps", input.confidence_bps, verified.confidence_bps);
    }
    if (verified.invalid_reason !== input.invalid_reason) {
      throw mismatch("invalid_reason", input.invalid_reason, verified.invalid_reason);
    }
    assertSameIsoSecond(verified.revealed_at, input.revealed_at, "revealed_at");
    return verified;
  }

  private async assertChain(inputChainId: number): Promise<void> {
    if (this.chainId !== null && this.chainId !== inputChainId) {
      throw new FhenixEventVerificationError(
        "Fhenix event chain_id does not match configured chain",
        "chain_mismatch",
        { expected: this.chainId, actual: inputChainId },
      );
    }
    let actual: number;
    try {
      actual = await this.client.getChainId();
    } catch (err) {
      throw new FhenixEventVerificationError(
        "failed to read Fhenix RPC chain id",
        "rpc_failure",
        { error: errorMessage(err) },
      );
    }
    if (actual !== inputChainId) {
      throw new FhenixEventVerificationError(
        "Fhenix event chain_id does not match RPC chain",
        "chain_mismatch",
        { expected: actual, actual: inputChainId },
      );
    }
  }

  private async readLog(input: {
    tx_hash: string;
    log_index: number;
    contract_address: string;
  }): Promise<ReceiptLog> {
    let receipt: { logs: readonly ReceiptLog[] };
    try {
      receipt = await this.client.getTransactionReceipt({ hash: input.tx_hash as Hex });
    } catch (err) {
      throw new FhenixEventVerificationError(
        "failed to read Fhenix transaction receipt",
        "rpc_failure",
        { tx_hash: input.tx_hash, error: errorMessage(err) },
      );
    }
    const log = receipt.logs.find((candidate) => candidate.logIndex === input.log_index);
    if (!log) {
      throw new FhenixEventVerificationError(
        "Fhenix event log index was not found in transaction receipt",
        "log_not_found",
        { tx_hash: input.tx_hash, log_index: input.log_index },
      );
    }
    assertSameAddress(log.address, input.contract_address, "contract_address");
    return log;
  }

  private assertAllowedContract(contractAddress: string): void {
    const normalized = normalizeAddress(contractAddress);
    if (!this.allowedContracts.has(normalized)) {
      throw new FhenixEventVerificationError(
        "Fhenix contract address is not allowlisted",
        "event_mismatch",
        { contract_address: normalized },
      );
    }
  }
}

export function createFhenixEventVerifierFromEnv(): FhenixEventVerifier | null {
  const rpcUrl = process.env.FHENIX_RPC_URL?.trim();
  if (!rpcUrl) return null;
  const rawChainId = process.env.FHENIX_CHAIN_ID?.trim();
  if (!rawChainId) {
    throw new FhenixEventVerificationError(
      "FHENIX_CHAIN_ID is required when FHENIX_RPC_URL is set",
      "not_configured",
    );
  }
  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new FhenixEventVerificationError(
      "FHENIX_CHAIN_ID must be a positive integer",
      "not_configured",
      { FHENIX_CHAIN_ID: rawChainId },
    );
  }
  const contractAddress = resolveFhenixContractAddress(chainId);
  if (!contractAddress) {
    throw new FhenixEventVerificationError(
      "Fhenix contract address must be resolvable from FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or data/deployments.json",
      "not_configured",
      { FHENIX_CHAIN_ID: rawChainId },
    );
  }
  return new ViemFhenixEventVerifier({ rpcUrl, chainId, contractAddress });
}

export function fhenixMarketIdForMurmurMarket(marketId: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    return marketId.toLowerCase();
  }
  return keccak256(toBytes(marketId)).toLowerCase();
}

function decodeExpectedEvent(
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

function normalizeAllowedContracts(config: ViemFhenixEventVerifierConfig): Set<string> {
  const values = [
    ...(config.contractAddresses ?? []),
    ...(config.contractAddress ? [config.contractAddress] : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeAddress);
  return new Set(values);
}

function invalidRevealReason(value: number): "binary_index" | "confidence" | "unknown" {
  if (value === 1) return "binary_index";
  if (value === 2) return "confidence";
  return "unknown";
}

function normalizeAddress(value: string): string {
  return getAddress(value as Address).toLowerCase();
}

function assertSameAddress(actual: string, expected: string, field: string): void {
  if (!isAddressEqual(getAddress(actual as Address), getAddress(expected as Address))) {
    throw mismatch(field, normalizeAddress(expected), normalizeAddress(actual));
  }
}

function assertSameHex(actual: string, expected: string, field: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw mismatch(field, expected.toLowerCase(), actual.toLowerCase());
  }
}

function assertSameIsoSecond(actual: string, expected: string, field: string): void {
  const actualMs = Date.parse(actual);
  const expectedMs = Date.parse(expected);
  if (!Number.isFinite(actualMs) || !Number.isFinite(expectedMs) || actualMs !== expectedMs) {
    throw mismatch(field, expected, actual);
  }
}

function unixSecondsToIso(value: bigint): string {
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

function lowerHex(value: string): string {
  return value.toLowerCase();
}

function mismatch(field: string, expected: unknown, actual: unknown): FhenixEventVerificationError {
  return new FhenixEventVerificationError(
    `Fhenix event ${field} mismatch`,
    "event_mismatch",
    { field, expected, actual },
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
