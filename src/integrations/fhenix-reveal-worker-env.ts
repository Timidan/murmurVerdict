import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { baseSepolia as cofheBaseSepolia } from "@cofhe/sdk/chains";

import {
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  resolveFhenixContractAddress,
} from "./deployments.js";
import { COFHE_404_RETRY_TIMEOUT_MS } from "./cofhe-decrypt-tuning.js";
import { createSerialBroadcastQueue } from "./fhenix-gateway-env.js";
import {
  RevealWrongStateError,
  type RevealChainAdapter,
  type RevealChainCall,
  type RevealChainReceipt,
  type RevealDecryptor,
} from "./fhenix-reveal-worker.js";

// The reveal EOA's own contract surface. openReveal / publishReveal are
// permissionless (any funded key) — the dedicated key needs no privilege, it
// only keeps the worker off the relayer key's nonce (Codex review §3).
const REVEAL_ABI = parseAbi([
  "function openReveal(bytes32 callId)",
  "function publishReveal(bytes32 callId, uint8 binaryIndex, uint16 confidenceBps, bytes binaryIndexSignature, bytes confidenceSignature)",
  "function getCall(bytes32 callId) view returns (address agent, bytes32 marketId, uint64 acceptedAt, bytes32 binaryIndexCtHash, bytes32 confidenceCtHash, uint8 revealedBinaryIndex, uint16 revealedConfidenceBps, uint8 state)",
]);

export class FhenixRevealWorkerConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "FhenixRevealWorkerConfigError";
    this.key = key;
  }
}

export interface FhenixRevealWorkerEnvConfig {
  chainId: number;
  contractAddress: string;
  /** Reveal EOA address (lowercased). Also the daemon_fallback attribution
   *  sender threaded into the watcher's reveal ingestion. */
  revealAddress: string;
  graceSeconds: number;
  retryBaseMs: number;
  retryMaxMs: number;
  rebroadcastMs: number;
  maxJobsPerTick: number;
  maxConcurrency: number;
  warnMs: number;
  escalateMs: number;
  tickSec: number;
  minBalanceWei: bigint;
  chain: RevealChainAdapter;
  decryptor: RevealDecryptor;
  /** Current reveal-EOA balance, for the startup funded-worker check. */
  getBalanceWei(): Promise<bigint>;
}

export interface FhenixRevealWorkerEnvOptions {
  contractAddress?: string | null;
  enabled?: boolean;
}

// Strict, default-OFF loader. Returns null when disabled; throws (fail-closed)
// on any invalid configuration when enabled — a mis-set reveal key must never
// silently no-op while sealed submissions accumulate unrevealed.
export function loadFhenixRevealWorkerEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: FhenixRevealWorkerEnvOptions = {},
): FhenixRevealWorkerEnvConfig | null {
  const enabled =
    opts.enabled ?? booleanEnv(env.FHENIX_REVEAL_WORKER_ENABLED, false, "FHENIX_REVEAL_WORKER_ENABLED");
  if (!enabled) return null;

  const rpcUrl = env.FHENIX_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new FhenixRevealWorkerConfigError(
      "FHENIX_RPC_URL",
      "FHENIX_REVEAL_WORKER_ENABLED=true requires FHENIX_RPC_URL",
    );
  }
  const chainIdInput = parseFhenixChainIdInput(env.FHENIX_CHAIN_ID);
  if (chainIdInput.kind === "empty") {
    throw new FhenixRevealWorkerConfigError(
      "FHENIX_CHAIN_ID",
      "FHENIX_REVEAL_WORKER_ENABLED=true requires FHENIX_CHAIN_ID",
    );
  }
  if (chainIdInput.kind === "invalid") {
    throw new FhenixRevealWorkerConfigError("FHENIX_CHAIN_ID", "must be a positive integer");
  }
  const chainId = chainIdInput.chainId;

  const privateKey = env.FHENIX_REVEAL_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new FhenixRevealWorkerConfigError(
      "FHENIX_REVEAL_PRIVATE_KEY",
      "FHENIX_REVEAL_WORKER_ENABLED=true requires FHENIX_REVEAL_PRIVATE_KEY (a DEDICATED reveal EOA, not the relayer key)",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new FhenixRevealWorkerConfigError(
      "FHENIX_REVEAL_PRIVATE_KEY",
      "must be a 32-byte 0x-prefixed private key",
    );
  }

  const contractAddress = resolveContractAddress(env, chainId, opts);
  if (!contractAddress) {
    throw new FhenixRevealWorkerConfigError(
      "FHENIX_SEALED_VERDICTS_ADDRESS",
      `FHENIX_REVEAL_WORKER_ENABLED=true but no contract address found for chainId ${chainId}`,
    );
  }

  const relayerKey = env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY?.trim();
  if (relayerKey && relayerKey.toLowerCase() === privateKey.toLowerCase()) {
    throw new FhenixRevealWorkerConfigError(
      "FHENIX_REVEAL_PRIVATE_KEY",
      "must differ from FHENIX_GATEWAY_RELAYER_PRIVATE_KEY — a dedicated key avoids nonce contention with the Gateway/discovery writers",
    );
  }

  const graceSeconds = integerEnv("FHENIX_REVEAL_WORKER_GRACE_SEC", 300, env, { min: 0 });
  const retryBaseMs = integerEnv("FHENIX_REVEAL_WORKER_RETRY_BASE_MS", 5_000, env, { min: 1_000 });
  const retryMaxMs = integerEnv(
    "FHENIX_REVEAL_WORKER_RETRY_MAX_MS",
    Math.max(300_000, retryBaseMs),
    env,
    { min: retryBaseMs },
  );
  // How long a broadcast open/publish tx may sit with no receipt before the
  // worker re-broadcasts it (self-heals a dropped / nonce-gapped reveal tx).
  // Must be at least retryBaseMs so a job is retried before it can go stale.
  const rebroadcastMs = integerEnv(
    "FHENIX_REVEAL_WORKER_REBROADCAST_MS",
    Math.max(90_000, retryBaseMs),
    env,
    { min: retryBaseMs },
  );
  const maxJobsPerTick = integerEnv("FHENIX_REVEAL_WORKER_MAX_JOBS_PER_TICK", 5, env, { min: 1 });
  const maxConcurrency = integerEnv("FHENIX_REVEAL_WORKER_MAX_CONCURRENCY", 2, env, { min: 1 });
  const confirmations = integerEnv("FHENIX_REVEAL_WORKER_CONFIRMATIONS", 2, env, { min: 0 });
  const tickSec = integerEnv("FHENIX_REVEAL_WORKER_TICK_SEC", 30, env, { min: 1 });
  const warnSec = integerEnv("FHENIX_REVEAL_WORKER_WARN_SEC", 600, env, { min: 0 });
  const escalateSec = integerEnv("FHENIX_REVEAL_WORKER_ESCALATE_SEC", 1_800, env, { min: warnSec });
  const minBalanceWei = weiEnv(
    "FHENIX_REVEAL_WORKER_MIN_BALANCE_WEI",
    20_000_000_000_000_000n, // 0.02 ETH
    env,
  );
  const withoutPermit = booleanEnv(
    env.FHENIX_REVEAL_WORKER_WITHOUT_PERMIT,
    false,
    "FHENIX_REVEAL_WORKER_WITHOUT_PERMIT",
  );

  const account = privateKeyToAccount(privateKey as Hex, { nonceManager });
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });
  // The reveal EOA's OWN serial broadcast queue — signer-agnostic helper reused
  // from the Gateway. NOT the relayer queue.
  const broadcastQueue = createSerialBroadcastQueue();

  const chain = createViemRevealChainAdapter({
    chainId,
    contractAddress,
    confirmations,
    publicClient,
    walletClient,
    account,
    broadcastQueue,
  });

  const cofheClient = createCofheClient(
    createCofheConfig({ environment: "node", supportedChains: [cofheBaseSepolia] }),
  );
  const decryptor = new CofheRevealDecryptor(
    cofheClient,
    publicClient,
    walletClient,
    account.address,
    withoutPermit,
  );

  return {
    chainId,
    contractAddress,
    revealAddress: account.address.toLowerCase(),
    graceSeconds,
    retryBaseMs,
    retryMaxMs,
    rebroadcastMs,
    maxJobsPerTick,
    maxConcurrency,
    warnMs: warnSec * 1_000,
    escalateMs: escalateSec * 1_000,
    tickSec,
    minBalanceWei,
    chain,
    decryptor,
    getBalanceWei: () => publicClient.getBalance({ address: account.address }),
  };
}

function createViemRevealChainAdapter(deps: {
  chainId: number;
  contractAddress: string;
  confirmations: number;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  broadcastQueue: ReturnType<typeof createSerialBroadcastQueue>;
}): RevealChainAdapter {
  const address = deps.contractAddress as Hex;
  // Serialize every reveal-EOA broadcast through its own queue and map a
  // WrongState revert to the reconcile marker.
  //
  // Before each serialized broadcast, reset THIS EOA's nonce cache (scoped by
  // address, so the relayer key's cache is untouched) so viem re-reads the
  // on-chain pending nonce. A dropped / evicted reveal tx leaves viem's
  // in-process nonceManager one ahead of the chain; without this reset a
  // re-broadcast would sign at the gap nonce and stay stuck. Re-reading the
  // pending count reclaims the dropped tx's nonce, letting the re-broadcast
  // replace it. `pending` counts still include a genuinely mempooled prior tx
  // (the serial queue awaits eth_sendRawTransaction before releasing), so this
  // never collides two live reveal txs on one nonce.
  const broadcastWrite = async (work: () => Promise<Hex>): Promise<string> => {
    try {
      return await deps.broadcastQueue.run(async () => {
        nonceManager.reset({ address: deps.account.address, chainId: deps.chainId });
        return work();
      });
    } catch (err) {
      if (isWrongStateError(err)) throw new RevealWrongStateError();
      throw err;
    }
  };
  return {
    async safeHead() {
      const latest = Number(await deps.publicClient.getBlockNumber());
      const safe = Math.max(0, latest - deps.confirmations);
      const block = await deps.publicClient.getBlock({ blockNumber: BigInt(safe) });
      return { blockNumber: safe, timestamp: Number(block.timestamp) };
    },
    async getCall(onchainCallId, blockNumber): Promise<RevealChainCall | null> {
      try {
        const call = (await deps.publicClient.readContract({
          address,
          abi: REVEAL_ABI,
          functionName: "getCall",
          args: [onchainCallId as Hex],
          blockNumber: BigInt(blockNumber),
        })) as readonly [string, string, bigint, string, string, number, number, number];
        return {
          binaryIndexCtHash: call[3],
          confidenceCtHash: call[4],
          state: Number(call[7]),
        };
      } catch (err) {
        // A revert (CallNotFound — state None) is a genuine "no on-chain state"
        // signal → null (worker quarantines). A network/RPC failure must NOT be
        // swallowed as null: rethrow so the worker reschedules instead.
        if (isRevertError(err)) return null;
        throw err;
      }
    },
    sendOpenReveal(onchainCallId) {
      return broadcastWrite(() =>
        deps.walletClient.writeContract({
          address,
          abi: REVEAL_ABI,
          functionName: "openReveal",
          args: [onchainCallId as Hex],
          account: deps.account,
          chain: null,
        } as never),
      );
    },
    sendPublishReveal(onchainCallId, args) {
      return broadcastWrite(() =>
        deps.walletClient.writeContract({
          address,
          abi: REVEAL_ABI,
          functionName: "publishReveal",
          args: [
            onchainCallId as Hex,
            args.binaryIndex,
            args.confidenceBps,
            args.binaryIndexSignature as Hex,
            args.confidenceSignature as Hex,
          ],
          account: deps.account,
          chain: null,
        } as never),
      );
    },
    async getReceipt(txHash): Promise<RevealChainReceipt | null> {
      try {
        const receipt = await deps.publicClient.getTransactionReceipt({ hash: txHash as Hex });
        return {
          blockNumber: Number(receipt.blockNumber),
          success: receipt.status === "success",
        };
      } catch {
        return null; // not mined yet
      }
    },
  };
}

class CofheRevealDecryptor implements RevealDecryptor {
  private connected = false;
  private permit: unknown = null;

  constructor(
    private readonly client: ReturnType<typeof createCofheClient>,
    private readonly publicClient: ReturnType<typeof createPublicClient>,
    private readonly walletClient: ReturnType<typeof createWalletClient>,
    private readonly issuer: string,
    private readonly withoutPermit: boolean,
  ) {}

  async decrypt(ctHash: string): Promise<{ value: number; signature: string }> {
    if (!this.connected) {
      await this.client.connect(this.publicClient as never, this.walletClient as never);
      if (!this.withoutPermit) {
        this.permit = await this.client.permits.createSelf({
          type: "self",
          issuer: this.issuer,
        });
      }
      this.connected = true;
    }
    // The SDK's 10s default 404 window is shorter than the ~5-30s the threshold
    // network needs to observe the post-openReveal ACL change, so a healthy
    // decrypt can be abandoned before the data exists. See
    // COFHE_404_RETRY_TIMEOUT_MS.
    const builder = this.client
      .decryptForTx(BigInt(ctHash))
      .set404RetryTimeout(COFHE_404_RETRY_TIMEOUT_MS);
    // The ciphertext is globally public after openReveal, so withoutPermit()
    // drops the permit lifecycle entirely when the SDK path is reliable
    // (Codex review §4); the permit path is the proven default.
    const exec = this.withoutPermit
      ? builder.withoutPermit()
      : builder.withPermit(this.permit as never);
    const result = (await exec.execute()) as { decryptedValue: bigint; signature: string };
    return { value: Number(result.decryptedValue), signature: result.signature };
  }
}

function resolveContractAddress(
  env: NodeJS.ProcessEnv,
  chainId: number,
  opts: FhenixRevealWorkerEnvOptions,
): string | null {
  if (opts.contractAddress === undefined) {
    return resolveFhenixContractAddress(chainId, env);
  }
  const parsed = parseFhenixAddressInput(opts.contractAddress);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixRevealWorkerConfigError(
    "FHENIX_SEALED_VERDICTS_ADDRESS",
    "must be a 20-byte 0x-prefixed address",
  );
}

function isRevertError(err: unknown): boolean {
  const text = errText(err);
  return /revert|CallNotFound|execution reverted|WrongState/i.test(text);
}

function isWrongStateError(err: unknown): boolean {
  return /WrongState/i.test(errText(err));
}

function errText(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (err instanceof Error) {
    const parts = [err.message];
    const withExtras = err as { shortMessage?: string; details?: string; cause?: unknown };
    if (withExtras.shortMessage) parts.push(withExtras.shortMessage);
    if (withExtras.details) parts.push(withExtras.details);
    if (withExtras.cause) parts.push(errText(withExtras.cause));
    return parts.join(" | ");
  }
  return String(err);
}

function booleanEnv(raw: string | undefined, fallback: boolean, key: string): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new FhenixRevealWorkerConfigError(key, "must be one of true, false, 1, or 0");
}

function integerEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
  opts: { min: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= opts.min) return value;
  throw new FhenixRevealWorkerConfigError(name, `must be an integer >= ${opts.min}`);
}

function weiEnv(name: string, fallback: bigint, env: NodeJS.ProcessEnv): bigint {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new FhenixRevealWorkerConfigError(name, "must be a non-negative integer wei amount");
  }
  return BigInt(raw);
}
