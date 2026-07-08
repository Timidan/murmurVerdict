import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  loadDeployment,
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  resolveFhenixContractAddress,
} from "./deployments.js";
import type { FhenixGatewayClient } from "./fhenix-gateway-contract.js";
import {
  SdkMurmurOwnedCofheSealer,
  type MurmurOwnedCofheSealer,
} from "./murmur-owned-cofhe-sealer.js";

export interface FhenixGatewayEnvConfig {
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  client: FhenixGatewayClient;
  murmurOwnedSealer: MurmurOwnedCofheSealer | null;
  confirmations: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  stuckAfterMs: number;
  broadcastTimeoutMs: number;
  /**
   * Block height the reconciliation getLogs scan starts from. Defaults to
   * the manifest deployment block (data/deployments.json) for
   * MurmurSealedVerdicts on this chainId; override via
   * FHENIX_GATEWAY_RECONCILE_FROM_BLOCK for testnet redeploys.
   */
  reconcileFromBlock: number;
}

export interface FhenixGatewayEnvConfigOptions {
  contractAddress?: string | null;
  enabled?: boolean;
}

export class FhenixGatewayEnvConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "FhenixGatewayEnvConfigError";
    this.key = key;
  }
}

export function loadFhenixGatewayEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: FhenixGatewayEnvConfigOptions = {},
): FhenixGatewayEnvConfig | null {
  const enabled = opts.enabled ??
    booleanEnv(env.FHENIX_GATEWAY_ENABLED, false, "FHENIX_GATEWAY_ENABLED");
  const rpcUrl = env.FHENIX_RPC_URL?.trim();
  const privateKey = env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY?.trim();
  const chainIdInput = parseFhenixChainIdInput(env.FHENIX_CHAIN_ID);
  if (!enabled) return null;
  if (!rpcUrl) {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_RPC_URL",
      "FHENIX_GATEWAY_ENABLED=true requires FHENIX_RPC_URL",
    );
  }
  if (chainIdInput.kind === "empty") {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_CHAIN_ID",
      "FHENIX_GATEWAY_ENABLED=true requires FHENIX_CHAIN_ID",
    );
  }
  if (!privateKey) {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
      "FHENIX_GATEWAY_ENABLED=true requires FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
    );
  }
  if (chainIdInput.kind === "invalid") {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_CHAIN_ID",
      "must be a positive integer",
    );
  }
  const chainId = chainIdInput.chainId;
  const contractAddress = resolveGatewayContractAddress(env, chainId, opts);
  if (!contractAddress) {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_SEALED_VERDICTS_ADDRESS",
      `FHENIX_GATEWAY_ENABLED=true but no contract address found: set FHENIX_SEALED_VERDICTS_ADDRESS, FHENIX_CONTRACT_ADDRESS, or run sync-deployments to populate data/deployments.json for chainId ${chainId}`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
      "must be a 32-byte 0x-prefixed private key",
    );
  }
  const confirmations = integerEnv("FHENIX_GATEWAY_CONFIRMATIONS", 2, env, {
    min: 0,
  });
  const murmurOwnedSealingEnabled = booleanEnv(
    env.MURMUR_OWNED_SEALING_ENABLED,
    true,
    "MURMUR_OWNED_SEALING_ENABLED",
  );
  const retryBaseMs = integerEnv("FHENIX_GATEWAY_RETRY_BASE_MS", 5_000, env, {
    min: 1_000,
  });
  const retryMaxMs = integerEnv(
    "FHENIX_GATEWAY_RETRY_MAX_MS",
    Math.max(120_000, retryBaseMs),
    env,
    { min: retryBaseMs },
  );
  const maxAttempts = integerEnv("FHENIX_GATEWAY_MAX_ATTEMPTS", 5, env, {
    min: 1,
  });
  const stuckAfterSec = integerEnv("FHENIX_GATEWAY_STUCK_SEC", 600, env, {
    min: 60,
  });
  const broadcastTimeoutMs = integerEnv(
    "FHENIX_GATEWAY_BROADCAST_TIMEOUT_MS",
    90_000,
    env,
    { min: 1_000, allowZero: true },
  );
  const reconcileFromBlock = integerEnv(
    "FHENIX_GATEWAY_RECONCILE_FROM_BLOCK",
    loadDeployment(chainId, "MurmurSealedVerdicts")?.blockNumber ?? 0,
    env,
    { min: 0, allowZero: true },
  );
  const account = privateKeyToAccount(privateKey as Hex);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  });
  const client: FhenixGatewayClient = {
    getChainId: () => publicClient.getChainId(),
    getBlockNumber: () => publicClient.getBlockNumber(),
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args),
    writeContract: (args) =>
      walletClient.writeContract({
        ...args,
        account,
        chain: null,
      } as never),
    // Reconciliation read path — viem's readContract throws on revert
    // (CallNotFound / PacketNotFound), which the reconciler wraps to mean
    // "no on-chain state".
    readContract: (args) =>
      publicClient.readContract({
        address: args.address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      } as never),
    // Filter SealedCallSubmitted / FeedPacketSubmitted by indexed id to
    // recover (txHash, logIndex, blockNumber) of a prior successful write
    // whose receipt was lost to a timeout.
    getLogs: (args) =>
      publicClient.getLogs({
        address: args.address,
        event: args.event,
        args: args.args,
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
      } as never) as unknown as Promise<never>,
  };
  return {
    chainId,
    contractAddress,
    relayerAddress: account.address,
    client,
    murmurOwnedSealer: murmurOwnedSealingEnabled
      ? new SdkMurmurOwnedCofheSealer(publicClient, walletClient)
      : null,
    confirmations,
    retryBaseMs,
    retryMaxMs,
    maxAttempts,
    stuckAfterMs: stuckAfterSec * 1_000,
    broadcastTimeoutMs,
    reconcileFromBlock,
  };
}

function resolveGatewayContractAddress(
  env: NodeJS.ProcessEnv,
  chainId: number,
  opts: FhenixGatewayEnvConfigOptions,
): string | null {
  if (opts.contractAddress === undefined) {
    return resolveFhenixContractAddress(chainId, env);
  }
  const parsed = parseFhenixAddressInput(opts.contractAddress);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixGatewayEnvConfigError(
    "FHENIX_SEALED_VERDICTS_ADDRESS",
    "must be a 20-byte 0x-prefixed address",
  );
}

function booleanEnv(
  raw: string | undefined,
  fallback: boolean,
  key: string,
): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new FhenixGatewayEnvConfigError(
    key,
    "must be one of true, false, 1, or 0",
  );
}

function integerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
  opts: { min: number; allowZero?: boolean },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    Number.isInteger(value) &&
    (value >= opts.min || (opts.allowZero === true && value === 0))
  ) {
    return value;
  }
  const message = opts.allowZero === true
    ? `must be 0 or an integer >= ${opts.min}`
    : `must be an integer >= ${opts.min}`;
  throw new FhenixGatewayEnvConfigError(name, message);
}
