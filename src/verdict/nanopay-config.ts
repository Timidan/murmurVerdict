import type { PipelineInfo } from "./nanopay-types.js";
import { parseBooleanToken } from "./env-grammar.js";

export interface NanopayPipelineAgentBinding {
  agentId: string;
  marketId: string;
}

/**
 * The settlement RAIL: who is paid, on which network, under which binding
 * domain. Shared by two independent products — paid inference (the nanopay
 * route) and paid decrypt-grants (/v2/gateway/calls/:callId/access).
 *
 * Deliberately carries no price. Each product prices itself
 * (MURMUR_NANOPAY_DEFAULT_PRICE / FHENIX_GRANT_PRICE_ATOMS), so a deployment
 * that sells only grants configures the rail without inventing an inference
 * price it will never charge.
 */
export interface NanopaySettlementRail {
  network: "testnet" | "mainnet";
  bindingDomain: {
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  sellerAddress: `0x${string}`;
  acceptNetworks?: string[];
}

export interface NanopayRuntimeConfig extends NanopaySettlementRail {
  defaultPrice: string;
  pipelineCatalog: Map<string, PipelineInfo>;
  pipelineAgentMap: Map<string, NanopayPipelineAgentBinding>;
}

export type NanopayRuntimeDecision =
  | { kind: "disabled" }
  | { kind: "unmounted" }
  /**
   * The rail is configured but the inference route is NOT mounted, because no
   * price was stated. Grants still work — they only need the rail. This is the
   * grant-only deployment shape.
   */
  | { kind: "rail_only"; rail: NanopaySettlementRail }
  | { kind: "mounted"; config: NanopayRuntimeConfig };

/** The settlement rail, whenever one is configured at all. */
export function nanopaySettlementRail(
  decision: NanopayRuntimeDecision,
): NanopaySettlementRail | null {
  if (decision.kind === "mounted") return decision.config;
  if (decision.kind === "rail_only") return decision.rail;
  return null;
}

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

  // Derived, not configured. The x402 binding domain IS the murmur deployment
  // a payment is bound to, so a separately-set chain id or contract could only
  // ever agree with the Fhenix config or be wrong — and "wrong" here means
  // signatures bound to a contract that is not the one being paid for.
  // MURMUR_NANOPAY_DOMAIN_CHAIN_ID / _DOMAIN_CONTRACT are gone.
  const domainChainId = fhenixChainId ?? 0;
  const domainContract = fhenixSealedVerdictsAddress ?? "";
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
      `[daemon] the x402 binding domain contract is not a valid 0x address (got ${domainContract}); it is derived from the Fhenix deployment, so fix FHENIX_SEALED_VERDICTS_ADDRESS or run sync-deployments. nanopay route NOT mounted`,
    );
    return { kind: "unmounted" };
  }

  const network = parseNetwork(env.MURMUR_NANOPAY_NETWORK);
  // NO DEFAULT PRICE. A hidden fallback charges real users a number nobody
  // chose and reads as intentional in every receipt. Mounting nanopay means
  // stating the price.
  const acceptNetworks = env.MURMUR_NANOPAY_ACCEPT_NETWORKS
    ? env.MURMUR_NANOPAY_ACCEPT_NETWORKS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const rail: NanopaySettlementRail = {
    network,
    bindingDomain: {
      chainId: domainChainId,
      verifyingContract: domainContract as `0x${string}`,
    },
    sellerAddress: sellerAddress as `0x${string}`,
    ...(acceptNetworks !== undefined ? { acceptNetworks } : {}),
  };

  // No price → the inference route does not mount. It cannot: the router
  // builds its payment gate eagerly, and that gate refuses to exist without a
  // price, so mounting priceless would be a startup crash rather than a
  // lazily-discovered 404.
  //
  // The RAIL is still returned. Paid decrypt-grants are a separate product on
  // the same settlement infrastructure — they are served by
  // /v2/gateway/calls/:callId/access and priced by FHENIX_GRANT_PRICE_ATOMS —
  // so a grant-only deployment enables nanopay for the rail and simply states
  // no inference price.
  const defaultPrice = env.MURMUR_NANOPAY_DEFAULT_PRICE?.trim();
  if (!defaultPrice) {
    logger.log(
      "[daemon] MURMUR_NANOPAY_DEFAULT_PRICE unset; paid-inference route NOT " +
        "mounted. The settlement rail stays configured, so paid decrypt-grants " +
        "still work (they price via FHENIX_GRANT_PRICE_ATOMS).",
    );
    return { kind: "rail_only", rail };
  }
  // A malformed price used to only warn, mounting an enabled but unusable
  // service. It must parse.
  const defaultPriceAtoms = parseDollarPriceToUsdcAtoms(defaultPrice);
  // $0 parses, but it makes every pipeline unusable: entries must be > 0 atoms
  // AND must equal this price, so a zero default rejects the whole catalog and
  // mounts a route that 404s everything. Nanopay is the PAID route; free
  // inference is not a mode it has.
  if (defaultPriceAtoms <= 0n) {
    throw new Error(
      `MURMUR_NANOPAY_DEFAULT_PRICE must be greater than zero (got "${defaultPrice}"). ` +
        "Nanopay is the paid-inference route; to serve nothing, leave " +
        "MURMUR_NANOPAY_ENABLED unset.",
    );
  }

  const pipelineCatalog = parseNanopayPipelinesEnv(
    env.MURMUR_NANOPAY_PIPELINES,
    defaultPriceAtoms,
    sellerAddress,
    logger,
  );
  // Entries are individually warned-and-skipped, so a wholly malformed value
  // used to degrade into "mounted, 404s everything" — the same enabled-but-
  // unusable state a malformed price now fails on. An operator who stated
  // pipelines meant to serve them; the per-entry warnings above say which
  // ones were rejected and why.
  if (env.MURMUR_NANOPAY_PIPELINES?.trim() && pipelineCatalog.size === 0) {
    throw new Error(
      "MURMUR_NANOPAY_PIPELINES is set but every entry was rejected — nanopay " +
        "would mount and 404 every request. Fix the entries listed in the " +
        "warnings above, or unset the variable.",
    );
  }
  const pipelineAgentMap = parseNanopayPipelineAgentMapEnv(
    env.MURMUR_NANOPAY_PIPELINE_AGENT_MAP,
    logger,
  );

  warnAboutNanopayCatalogDrift(pipelineCatalog, pipelineAgentMap, logger);

  return {
    kind: "mounted",
    config: { ...rail, defaultPrice, pipelineCatalog, pipelineAgentMap },
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
