import type { PipelineInfo } from "./nanopay-types.js";
import { parseBooleanToken } from "./env-grammar.js";

export interface NanopayPipelineAgentBinding {
  agentId: string;
  marketId: string;
}

export interface NanopayRuntimeConfig {
  network: "testnet" | "mainnet";
  bindingDomain: {
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  sellerAddress: `0x${string}`;
  defaultPrice: string;
  acceptNetworks?: string[];
  pipelineCatalog: Map<string, PipelineInfo>;
  pipelineAgentMap: Map<string, NanopayPipelineAgentBinding>;
}

export type NanopayRuntimeDecision =
  | { kind: "disabled" }
  | { kind: "unmounted" }
  | { kind: "mounted"; config: NanopayRuntimeConfig };

export interface NanopayRuntimeConfigInput {
  env: NodeJS.ProcessEnv;
  fhenixChainId: number | null;
  fhenixSealedVerdictsAddress: string | null;
  logger?: Pick<typeof console, "warn" | "log">;
}

export class NanopayRuntimeConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "NanopayRuntimeConfigError";
    this.key = key;
  }
}

/**
 * Converts operator env into the complete nanopay route config.
 * The daemon should only decide where to mount the route; this module owns
 * validation, warnings, and the immutable pipeline maps used by preflight.
 */
export function loadNanopayRuntimeConfig(
  input: NanopayRuntimeConfigInput,
): NanopayRuntimeDecision {
  const { env, fhenixChainId, fhenixSealedVerdictsAddress } = input;
  const logger = input.logger ?? console;

  if (!parseBooleanFlag(env.MURMUR_NANOPAY_ENABLED, false, "MURMUR_NANOPAY_ENABLED")) {
    return { kind: "disabled" };
  }

  const domainChainId = Number(
    env.MURMUR_NANOPAY_DOMAIN_CHAIN_ID ??
      (fhenixChainId ? String(fhenixChainId) : undefined) ??
      "0",
  );
  const domainContract =
    env.MURMUR_NANOPAY_DOMAIN_CONTRACT ??
    fhenixSealedVerdictsAddress ??
    "";
  const sellerAddress = env.MURMUR_NANOPAY_SELLER_ADDRESS ?? "";

  if (!domainChainId || !domainContract || !sellerAddress) {
    logger.warn(
      "[daemon] MURMUR_NANOPAY_ENABLED=true but required config missing (need MURMUR_NANOPAY_SELLER_ADDRESS + domain chainId + domain contract); nanopay route NOT mounted",
    );
    return { kind: "unmounted" };
  }
  if (!isHexAddress(sellerAddress)) {
    logger.warn(
      `[daemon] MURMUR_NANOPAY_SELLER_ADDRESS not a valid 0x address (got ${sellerAddress}); nanopay route NOT mounted`,
    );
    return { kind: "unmounted" };
  }
  if (!isHexAddress(domainContract)) {
    logger.warn(
      `[daemon] MURMUR_NANOPAY_DOMAIN_CONTRACT not a valid 0x address (got ${domainContract}); nanopay route NOT mounted`,
    );
    return { kind: "unmounted" };
  }

  const network = parseNetwork(env.MURMUR_NANOPAY_NETWORK);
  const defaultPrice = env.MURMUR_NANOPAY_DEFAULT_PRICE ?? "$0.001";
  const acceptNetworks = env.MURMUR_NANOPAY_ACCEPT_NETWORKS
    ? env.MURMUR_NANOPAY_ACCEPT_NETWORKS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  let defaultPriceAtoms: bigint | null = null;
  try {
    defaultPriceAtoms = parseDollarPriceToUsdcAtoms(defaultPrice);
  } catch (err) {
    logger.warn(
      `[daemon] MURMUR_NANOPAY_DEFAULT_PRICE "${defaultPrice}" unparseable; nanopay pipeline catalog will be empty. Reason: ${(err as Error).message}`,
    );
  }

  const pipelineCatalog =
    defaultPriceAtoms !== null
      ? parseNanopayPipelinesEnv(
          env.MURMUR_NANOPAY_PIPELINES,
          defaultPriceAtoms,
          sellerAddress,
          logger,
        )
      : new Map<string, PipelineInfo>();
  const pipelineAgentMap = parseNanopayPipelineAgentMapEnv(
    env.MURMUR_NANOPAY_PIPELINE_AGENT_MAP,
    logger,
  );

  warnAboutNanopayCatalogDrift(pipelineCatalog, pipelineAgentMap, logger);

  return {
    kind: "mounted",
    config: {
      network,
      bindingDomain: {
        chainId: domainChainId,
        verifyingContract: domainContract as `0x${string}`,
      },
      sellerAddress: sellerAddress as `0x${string}`,
      defaultPrice,
      ...(acceptNetworks !== undefined ? { acceptNetworks } : {}),
      pipelineCatalog,
      pipelineAgentMap,
    },
  };
}

function warnAboutNanopayCatalogDrift(
  pipelineCatalog: Map<string, PipelineInfo>,
  pipelineAgentMap: Map<string, NanopayPipelineAgentBinding>,
  logger: Pick<typeof console, "warn" | "log">,
): void {
  if (pipelineCatalog.size === 0) {
    logger.warn(
      "[daemon] MURMUR_NANOPAY_PIPELINES is empty or all entries were rejected; nanopay route mounted but will preflight-404 every request until the env is set",
    );
  } else {
    logger.log(
      `[daemon] Nanopay pipeline catalog parsed: ${pipelineCatalog.size} pipeline(s)`,
    );
  }
  if (pipelineCatalog.size > 0 && pipelineAgentMap.size === 0) {
    logger.warn(
      "[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP is empty; cataloged pipelines will preflight-503 because no sealed-call mapping exists",
    );
  }
  for (const pipelineId of pipelineCatalog.keys()) {
    if (!pipelineAgentMap.has(pipelineId)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP: cataloged pipeline ${pipelineId} has no agent/market mapping; calls will preflight-503`,
      );
    }
  }
  for (const pipelineId of pipelineAgentMap.keys()) {
    if (!pipelineCatalog.has(pipelineId)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: agent-map entry for ${pipelineId} has no catalog entry; calls will preflight-404 (dead config)`,
      );
    }
  }
}

function parseBooleanFlag(
  raw: string | undefined,
  fallback: boolean,
  key: string,
): boolean {
  if (!raw?.trim()) return fallback;
  const value = parseBooleanToken(raw);
  if (value === undefined) {
    throw new NanopayRuntimeConfigError(
      key,
      "must be one of true, false, 1, or 0",
    );
  }
  return value;
}

function parseNetwork(raw: string | undefined): "testnet" | "mainnet" {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized || normalized === "testnet") return "testnet";
  if (normalized === "mainnet") return "mainnet";
  throw new NanopayRuntimeConfigError(
    "MURMUR_NANOPAY_NETWORK",
    "must be one of testnet or mainnet",
  );
}

/**
 * Parses `MURMUR_NANOPAY_PIPELINES`. Format:
 *
 *   <pipelineId>:<priceAtoms>:<recipient>:<chainId>[,...]
 */
export function parseNanopayPipelinesEnv(
  raw: string | undefined,
  expectedAtoms: bigint,
  expectedSeller: string,
  logger: Pick<typeof console, "warn"> = console,
): Map<string, PipelineInfo> {
  const out = new Map<string, PipelineInfo>();
  if (!raw || raw.trim() === "") return out;
  const expectedSellerLower = expectedSeller.toLowerCase();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    if (parts.length !== 4) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: malformed entry "${trimmed}" (need 4 colon-separated fields); skipping`,
      );
      continue;
    }
    const [pipelineId, priceAtomsStr, recipient, chainIdStr] = parts;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pipelineId)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: bad pipelineId "${pipelineId}" (need 0x + 64 hex); skipping`,
      );
      continue;
    }
    if (!/^\d+$/.test(priceAtomsStr)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: priceAtoms "${priceAtomsStr}" for ${pipelineId} is not a plain decimal integer; skipping`,
      );
      continue;
    }
    let priceAtoms: bigint;
    try {
      priceAtoms = BigInt(priceAtomsStr);
    } catch {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: bad priceAtoms "${priceAtomsStr}" for ${pipelineId}; skipping`,
      );
      continue;
    }
    if (priceAtoms <= 0n) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: priceAtoms must be > 0 for ${pipelineId} (got ${priceAtomsStr}); skipping`,
      );
      continue;
    }
    if (priceAtoms !== expectedAtoms) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: priceAtoms ${priceAtomsStr} for ${pipelineId} does not match MURMUR_NANOPAY_DEFAULT_PRICE (${expectedAtoms.toString()} atoms); skipping (Phase 1b enforces single shared price)`,
      );
      continue;
    }
    if (!isHexAddress(recipient)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: bad recipient "${recipient}" for ${pipelineId}; skipping`,
      );
      continue;
    }
    if (recipient.toLowerCase() !== expectedSellerLower) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: recipient ${recipient} for ${pipelineId} does not match MURMUR_NANOPAY_SELLER_ADDRESS (${expectedSeller}); skipping (Phase 1b enforces single shared seller)`,
      );
      continue;
    }
    if (!/^\d+$/.test(chainIdStr)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: chainId "${chainIdStr}" for ${pipelineId} is not a plain decimal integer; skipping`,
      );
      continue;
    }
    const chainId = Number(chainIdStr);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: bad chainId "${chainIdStr}" for ${pipelineId}; skipping`,
      );
      continue;
    }
    const key = pipelineId.toLowerCase();
    if (out.has(key)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINES: duplicate pipelineId ${pipelineId}; last-write-wins`,
      );
    }
    out.set(key, {
      priceAtoms: priceAtoms.toString(),
      recipient: recipient as `0x${string}`,
      chainId,
    });
  }
  return out;
}

/**
 * Parses `MURMUR_NANOPAY_PIPELINE_AGENT_MAP`. Format:
 *
 *   <pipelineId>:<agentId>:<marketId>[,...]
 */
export function parseNanopayPipelineAgentMapEnv(
  raw: string | undefined,
  logger: Pick<typeof console, "warn"> = console,
): Map<string, NanopayPipelineAgentBinding> {
  const out = new Map<string, NanopayPipelineAgentBinding>();
  if (!raw || raw.trim() === "") return out;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    if (parts.length !== 3) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP: malformed entry "${trimmed}" (need 3 colon-separated fields: pipelineId:agentId:marketId); skipping`,
      );
      continue;
    }
    const [pipelineId, agentId, marketId] = parts;
    if (!/^0x[0-9a-fA-F]{64}$/.test(pipelineId)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP: bad pipelineId "${pipelineId}"; skipping`,
      );
      continue;
    }
    if (!agentId || agentId.includes(":") || agentId.includes(",")) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP: bad agentId for ${pipelineId} (must be non-empty and contain no ':' or ','); skipping`,
      );
      continue;
    }
    if (!marketId || marketId.includes(":") || marketId.includes(",")) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP: bad marketId for ${pipelineId} (must be non-empty and contain no ':' or ','); skipping`,
      );
      continue;
    }
    const key = pipelineId.toLowerCase();
    if (out.has(key)) {
      logger.warn(
        `[daemon] MURMUR_NANOPAY_PIPELINE_AGENT_MAP: duplicate pipelineId ${pipelineId}; last-write-wins`,
      );
    }
    out.set(key, { agentId, marketId });
  }
  return out;
}

export function parseDollarPriceToUsdcAtoms(price: string): bigint {
  const m = price.match(/^\$?(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) {
    throw new Error(
      `parseDollarPriceToUsdcAtoms: cannot parse "${price}" (need $D or $D.d[d...] with <=6 fractional digits)`,
    );
  }
  const whole = m[1];
  const frac = (m[2] ?? "").padEnd(6, "0");
  return BigInt(whole) * 1_000_000n + BigInt(frac);
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
