import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  type Hex,
  type LocalAccount,
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
  ViemFhenixMarketRegistrar,
  type FhenixMarketRegistrar,
} from "./fhenix-market-registration.js";
import {
  SdkMurmurOwnedCofheSealer,
  type MurmurOwnedCofheSealer,
} from "./murmur-owned-cofhe-sealer.js";
import {
  parseGatewayFingerprintHmacKeyring,
  type GatewayFingerprintHmacKeyring,
} from "./gateway-request-fingerprint.js";

export interface FhenixGatewayEnvConfig {
  chainId: number;
  contractAddress: string;
  relayerAddress: string;
  client: FhenixGatewayClient;
  murmurOwnedSealer: MurmurOwnedCofheSealer | null;
  fingerprintHmacKeyring: GatewayFingerprintHmacKeyring | null;
  /** MURMUR_ACK_FEED_REVEAL_MANUAL. Feed packet submission 503s without it. */
  feedRevealAcknowledged: boolean;
  /** FHENIX_RECONCILE_OLD_FROM_BLOCK; see the attempt machine's mismatch branch. */
  reconcileOldFromBlock: number | null;
  /**
   * Owner-plane market registrar built on the SAME account, clients, and
   * broadcast queue as the Gateway relayer — the discovery ticker and the
   * Gateway must never allocate this key's nonces independently.
   */
  marketRegistrar: FhenixMarketRegistrar;
  confirmations: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxAttempts: number;
  stuckAfterMs: number;
  broadcastTimeoutMs: number;
  /**
   * Block height the reconciliation getLogs scan starts from: the manifest
   * deployment block for MurmurSealedVerdicts on this chainId.
   *
   * NOT overridable. It used to accept FHENIX_GATEWAY_RECONCILE_FROM_BLOCK
   * "for testnet redeploys", which is precisely backwards — after a redeploy
   * the manifest is right and the override is stale. The sibling
   * FHENIX_EVENT_START_BLOCK did exactly that today and silently stopped the
   * watcher from ever reaching a reveal.
   */
  reconcileFromBlock: number;
}

export interface FhenixGatewayEnvConfigOptions {
  contractAddress?: string | null;
  enabled?: boolean;
  /** A resolved signer (KMS-backed). When set, no raw key is read. */
  account?: LocalAccount;
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
  const murmurOwnedSealingEnabled = booleanEnv(
    env.MURMUR_OWNED_SEALING_ENABLED,
    false,
    "MURMUR_OWNED_SEALING_ENABLED",
  );
  let fingerprintHmacKeyring: GatewayFingerprintHmacKeyring | null = null;
  if (murmurOwnedSealingEnabled) {
    try {
      fingerprintHmacKeyring = parseGatewayFingerprintHmacKeyring(
        env.MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS,
      );
    } catch (err) {
      throw new FhenixGatewayEnvConfigError(
        "MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!fingerprintHmacKeyring) {
      throw new FhenixGatewayEnvConfigError(
        "MURMUR_GATEWAY_FINGERPRINT_HMAC_KEYS",
        "MURMUR_OWNED_SEALING_ENABLED=true requires a 256-bit HMAC key; configure active-id:$(openssl rand -hex 32)",
      );
    }
  }
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
  if (!privateKey && !opts.account) {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
      "FHENIX_GATEWAY_ENABLED=true requires FHENIX_GATEWAY_RELAYER_PRIVATE_KEY or FHENIX_GATEWAY_RELAYER_KMS_KEY_ID",
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
      `FHENIX_GATEWAY_ENABLED=true but no contract address found: run sync-deployments to populate data/deployments.json for chainId ${chainId}, or set FHENIX_SEALED_VERDICTS_ADDRESS`,
    );
  }
  if (!opts.account && !/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) {
    throw new FhenixGatewayEnvConfigError(
      "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
      "must be a 32-byte 0x-prefixed private key",
    );
  }
  const confirmations = integerEnv("FHENIX_GATEWAY_CONFIRMATIONS", 2, env, {
    min: 0,
  });
  // Defaults OFF. This path accepts a PLAINTEXT verdict over HTTP and seals it
  // server-side, so with it enabled Murmur can read every pending prediction —
  // the operator is a non-subscriber with full early access. Client-sealed
  // submission (`privacy_mode: "sealed_fhenix"`, CofheInput handles) is the
  // private path and needs no flag. Enabling this is an explicit, auditable
  // decision to trust the operator, never a default.
  // Feed packets have no reveal path yet (see the gate in fhenix-gateway.ts).
  // Defaults OFF so nobody builds a feed product on a value that can never be
  // read back.
  // Optional. Set to the PREVIOUS deployment's block after a redeploy so a
  // write that landed on the old contract, and whose receipt was lost, can
  // still be recovered. Without it that lookup is skipped and the attempt's
  // terminal error says the search was not performed.
  const reconcileOldFromBlockRaw = env.FHENIX_RECONCILE_OLD_FROM_BLOCK?.trim();
  const reconcileOldFromBlock = reconcileOldFromBlockRaw
    ? integerEnv("FHENIX_RECONCILE_OLD_FROM_BLOCK", 0, env, { min: 0 })
    : null;
  const feedRevealAcknowledged = booleanEnv(
    env.MURMUR_ACK_FEED_REVEAL_MANUAL,
    false,
    "MURMUR_ACK_FEED_REVEAL_MANUAL",
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
  const reconcileFromBlock =
    loadDeployment(chainId, "MurmurSealedVerdicts")?.blockNumber ?? 0;
  // One nonce-managed account + one broadcast queue for every writer on this
  // key. The Gateway's HTTP submit handlers, the gateway tick, and the market
  // discovery registrar all sign with the same EOA; without shared nonce
  // allocation two overlapping broadcasts race the same nonce and one revert
  // is guaranteed. The queue serializes allocate/sign/broadcast only —
  // receipt waiting happens outside it.
  const account = opts.account ?? privateKeyToAccount(privateKey as Hex, { nonceManager });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  });
  const broadcastQueue = createSerialBroadcastQueue();
  const client: FhenixGatewayClient = {
    getChainId: () => publicClient.getChainId(),
    getBlockNumber: () => publicClient.getBlockNumber(),
    getTransactionReceipt: (args) => publicClient.getTransactionReceipt(args),
    writeContract: (args, opts) =>
      broadcastQueue.run(() => {
        // Last-moment halt seam: runs inside the serialized slot so a kill
        // switch engaged while this write waited in the queue still stops it.
        opts?.preBroadcast?.();
        return walletClient.writeContract({
          ...args,
          account,
          chain: null,
        } as never);
      }),
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
  const marketRegistrar = new ViemFhenixMarketRegistrar({
    chainId,
    contractAddress,
    relayerAddress: account.address,
    publicClient,
    // The halt seam runs INSIDE the queue slot. Agent kill switches do not
    // apply here (registration is daemon-owned), but an operator market halt
    // does: registration can wait behind another relayer write for an
    // unbounded time, and it is one-shot on-chain, so a broadcast sent after
    // the halt permanently registers a market someone deliberately pulled.
    writeContract: (args, opts) =>
      broadcastQueue.run(() => {
        opts?.preBroadcast?.();
        return walletClient.writeContract({
          ...args,
          account,
          chain: null,
        } as never);
      }),
  });
  return {
    chainId,
    contractAddress,
    relayerAddress: account.address,
    client,
    murmurOwnedSealer: murmurOwnedSealingEnabled
      ? new SdkMurmurOwnedCofheSealer(
          publicClient,
          walletClient,
          // CoFHE 0.7 binds both into the batch signature: the consuming
          // contract and the relayer that broadcasts the submission.
          contractAddress,
          account.address,
        )
      : null,
    fingerprintHmacKeyring: murmurOwnedSealingEnabled
      ? fingerprintHmacKeyring
      : null,
    feedRevealAcknowledged,
    reconcileOldFromBlock,
    marketRegistrar,
    confirmations,
    retryBaseMs,
    retryMaxMs,
    maxAttempts,
    stuckAfterMs: stuckAfterSec * 1_000,
    broadcastTimeoutMs,
    reconcileFromBlock,
  };
}

export interface SerialBroadcastQueue {
  run<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Promise-chain mutex for relayer-key broadcasts. Every writeContract on the
 * shared EOA (Gateway sealed calls, feed packets, discovery market
 * registrations) enters here so nonce allocation + sign + broadcast happen
 * one at a time; callers await receipts on their own afterwards. A failed
 * broadcast never poisons the chain — the tail always settles.
 *
 * In-process only: with multiple daemon replicas holding this key, exactly
 * one replica may run write-enabled (see the operator guide).
 */
export function createSerialBroadcastQueue(): SerialBroadcastQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work, work);
      tail = next.catch(() => undefined);
      return next;
    },
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
