import {
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import {
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  resolveFhenixContractAddress,
} from "./deployments.js";
import {
  FhenixEventVerificationError,
  SEALED_CALL_SUBMITTED_EVENT,
  VERDICT_REVEALED_EVENT,
  VERDICT_REVEAL_INVALID_EVENT,
  assertSameAddress,
  assertSameHex,
  assertSameIsoSecond,
  decodeExpectedEvent,
  errorMessage,
  fhenixMarketIdForMurmurMarket,
  invalidRevealReason,
  lowerHex,
  mismatch,
  normalizeAddress,
  normalizeAllowedContracts,
  unixSecondsToIso,
  type ReceiptClient,
  type ReceiptLog,
  type VerifiedSealedCallSubmitted,
  type VerifiedVerdictRevealInvalid,
  type VerifiedVerdictRevealed,
  type VerifySealedCallSubmittedInput,
  type VerifyVerdictRevealInvalidInput,
  type VerifyVerdictRevealedInput,
} from "./fhenix-event-primitives.js";

export {
  FEED_PACKET_SUBMITTED_EVENT,
  FhenixEventVerificationError,
  SEALED_CALL_SUBMITTED_EVENT,
  VERDICT_REVEALED_EVENT,
  VERDICT_REVEAL_INVALID_EVENT,
  fhenixMarketIdForMurmurMarket,
} from "./fhenix-event-primitives.js";
export type {
  FhenixInvalidRevealMetadata,
  FhenixRevealMetadata,
  FhenixSealedCallSubmitMetadata,
  FhenixVerificationErrorKind,
  VerifiedSealedCallSubmitted,
  VerifiedVerdictRevealInvalid,
  VerifiedVerdictRevealed,
  VerifySealedCallSubmittedInput,
  VerifyVerdictRevealInvalidInput,
  VerifyVerdictRevealedInput,
} from "./fhenix-event-primitives.js";

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

export interface FhenixEventVerifierConfigOptions {
  contractAddress?: string | null;
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

export function loadFhenixEventVerifierConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: FhenixEventVerifierConfigOptions = {},
): ViemFhenixEventVerifierConfig | null {
  const rpcUrl = env.FHENIX_RPC_URL?.trim();
  if (!rpcUrl) return null;
  const chainIdInput = parseFhenixChainIdInput(env.FHENIX_CHAIN_ID);
  if (chainIdInput.kind === "empty") {
    throw new FhenixEventVerificationError(
      "FHENIX_CHAIN_ID is required when FHENIX_RPC_URL is set",
      "not_configured",
    );
  }
  if (chainIdInput.kind === "invalid") {
    throw new FhenixEventVerificationError(
      "FHENIX_CHAIN_ID must be a positive integer",
      "not_configured",
      { FHENIX_CHAIN_ID: chainIdInput.raw },
    );
  }
  const chainId = chainIdInput.chainId;
  const contractAddress = resolveVerifierContractAddress(env, chainId, opts);
  if (!contractAddress) {
    throw new FhenixEventVerificationError(
      "Fhenix contract address must be resolvable from FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or data/deployments.json",
      "not_configured",
      { FHENIX_CHAIN_ID: String(chainId) },
    );
  }
  return { rpcUrl, chainId, contractAddress };
}

export function createFhenixEventVerifierFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: FhenixEventVerifierConfigOptions = {},
): FhenixEventVerifier | null {
  const config = loadFhenixEventVerifierConfig(env, opts);
  return config ? new ViemFhenixEventVerifier(config) : null;
}

function resolveVerifierContractAddress(
  env: NodeJS.ProcessEnv,
  chainId: number,
  opts: FhenixEventVerifierConfigOptions,
): string | null {
  if (opts.contractAddress === undefined) {
    return resolveFhenixContractAddress(chainId, env);
  }
  const parsed = parseFhenixAddressInput(opts.contractAddress);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixEventVerificationError(
    "FHENIX_SEALED_VERDICTS_ADDRESS must be a 20-byte 0x-prefixed address",
    "not_configured",
    { FHENIX_SEALED_VERDICTS_ADDRESS: opts.contractAddress },
  );
}
