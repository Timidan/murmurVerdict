import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const DeploymentEntrySchema = z.object({
  chainId: z.number().int().positive(),
  contractName: z.string().min(1),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  deployedAt: z.string().datetime(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  blockNumber: z.number().int().nonnegative(),
});
export type DeploymentEntry = z.infer<typeof DeploymentEntrySchema>;

const ManifestSchema = z.array(DeploymentEntrySchema);
const EvmAddressPattern = /^0x[a-fA-F0-9]{40}$/;

export class FhenixDeploymentConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "FhenixDeploymentConfigError";
    this.key = key;
  }
}

export interface FhenixDeploymentAddresses {
  sealedVerdictsAddress: string | null;
  escrowAddress: string | null;
}

export type FhenixAddressInput =
  | { kind: "empty" }
  | { kind: "address"; address: string }
  | { kind: "invalid"; raw: string };

export type FhenixChainIdInput =
  | { kind: "empty" }
  | { kind: "chain_id"; chainId: number }
  | { kind: "invalid"; raw: string };

export function parseFhenixAddressInput(
  raw: string | null | undefined,
): FhenixAddressInput {
  const trimmed = raw?.trim();
  if (!trimmed) return { kind: "empty" };
  if (EvmAddressPattern.test(trimmed)) {
    return { kind: "address", address: trimmed };
  }
  return { kind: "invalid", raw: trimmed };
}

export function parseFhenixChainIdInput(
  raw: string | null | undefined,
): FhenixChainIdInput {
  const trimmed = raw?.trim();
  if (!trimmed) return { kind: "empty" };
  const chainId = Number(trimmed);
  if (Number.isInteger(chainId) && chainId > 0) {
    return { kind: "chain_id", chainId };
  }
  return { kind: "invalid", raw: trimmed };
}

/**
 * Which chain this deployment runs on.
 *
 * DERIVED from data/deployments.json when that manifest describes exactly one
 * chain — which is the normal case, and makes FHENIX_CHAIN_ID one more copy of
 * a fact the manifest already states. A copy is a thing that can go stale: the
 * sibling FHENIX_EVENT_START_BLOCK did exactly that and silently stopped the
 * watcher from indexing reveals.
 *
 * Still settable, for two real cases: a manifest spanning several chains (then
 * it is REQUIRED, since nothing else disambiguates), and an operator who wants
 * the value stated explicitly. Set and disagreeing with a single-chain
 * manifest is refused rather than resolved — a mismatch means the operator
 * believes they are on a different network, and picking either answer risks
 * signing against the wrong one.
 *
 * The RPC is not consulted here: config loading is synchronous, and the
 * gateway already asserts the RPC's chain matches before it broadcasts.
 */
export function resolveFhenixChainId(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const parsed = parseFhenixChainIdInput(env.FHENIX_CHAIN_ID);
  if (parsed.kind === "invalid") {
    throw new FhenixDeploymentConfigError(
      "FHENIX_CHAIN_ID",
      "must be a positive integer",
    );
  }

  const manifestChains = new Set(
    readManifest(manifestPath(env)).map((entry) => entry.chainId),
  );

  if (parsed.kind === "chain_id") {
    if (manifestChains.size === 1 && !manifestChains.has(parsed.chainId)) {
      const [only] = [...manifestChains];
      throw new FhenixDeploymentConfigError(
        "FHENIX_CHAIN_ID",
        `is ${parsed.chainId} but data/deployments.json only describes chain ` +
          `${only}. Refusing to guess: either drop FHENIX_CHAIN_ID (it is ` +
          `derived from the manifest) or sync the manifest for ${parsed.chainId}.`,
      );
    }
    return parsed.chainId;
  }

  if (manifestChains.size === 1) {
    const [only] = [...manifestChains];
    return only!;
  }
  if (manifestChains.size > 1) {
    throw new FhenixDeploymentConfigError(
      "FHENIX_CHAIN_ID",
      `is required: data/deployments.json describes ${manifestChains.size} ` +
        `chains (${[...manifestChains].sort().join(", ")}), so it cannot be derived.`,
    );
  }
  return null;
}

export function manifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DEPLOYMENTS_MANIFEST_PATH ??
    join(process.cwd(), "data", "deployments.json")
  );
}

export function readManifest(path: string = manifestPath()): DeploymentEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw === "") return [];
  return ManifestSchema.parse(JSON.parse(raw));
}

/// @returns the most-recently-deployed entry for (chainId, contractName),
///          or null if none exists.
export function loadDeployment(
  chainId: number,
  contractName: string,
  path: string = manifestPath(),
): DeploymentEntry | null {
  const entries = readManifest(path)
    .filter(e => e.chainId === chainId && e.contractName === contractName)
    .sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt));
  return entries[0] ?? null;
}

/// @returns the deployment entry for (chainId, contractName) whose `address`
///          matches `resolvedAddress` case-insensitively AND carries a
///          positive blockNumber. Unlike loadDeployment (which returns the
///          latest-by-name entry regardless of address), this lets a caller
///          that already resolved a contract address pull the block number
///          from the SAME manifest entry as that address — so a watcher never
///          starts scanning from a block that belongs to a different (e.g.
///          newer) deployment of the same contract name. Returns null when no
///          such entry exists; the caller decides the fallback.
export function loadDeploymentByAddress(
  chainId: number,
  contractName: string,
  resolvedAddress: string,
  path: string = manifestPath(),
): DeploymentEntry | null {
  const target = resolvedAddress.trim().toLowerCase();
  if (!EvmAddressPattern.test(target)) return null;
  const entries = readManifest(path)
    .filter(
      e =>
        e.chainId === chainId &&
        e.contractName === contractName &&
        e.address.toLowerCase() === target &&
        e.blockNumber > 0,
    )
    .sort((a, b) => Date.parse(b.deployedAt) - Date.parse(a.deployedAt));
  return entries[0] ?? null;
}

// Single source of truth for resolving the MurmurSealedVerdicts address from
// env or the deployment manifest. Watcher, gateway, verifier, daemon, canary,
// and seed tools all share this so the allowlist they enforce can never drift.
export function resolveFhenixContractAddress(
  chainId?: number,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const sealedVerdictsAddress = addressFromEnv(
    env.FHENIX_SEALED_VERDICTS_ADDRESS,
    "FHENIX_SEALED_VERDICTS_ADDRESS",
  );
  if (sealedVerdictsAddress) return sealedVerdictsAddress;

  // Two names for one value meant sync-deployments could update one and leave
  // the other pointing at a dead contract — harmless only while the primary
  // was set, and a live trap the moment it was cleared.
  if (chainId === undefined) return null;
  return loadDeployment(
    chainId,
    "MurmurSealedVerdicts",
    manifestPath(env),
  )?.address ?? null;
}

export function resolveFhenixDeploymentAddresses(
  chainId?: number,
  env: NodeJS.ProcessEnv = process.env,
): FhenixDeploymentAddresses {
  const manifest = chainId === undefined ? null : manifestPath(env);
  const envEscrowAddress = addressFromEnv(
    env.FHENIX_ESCROW_ADDRESS,
    "FHENIX_ESCROW_ADDRESS",
  );
  const manifestEscrowAddress =
    chainId === undefined
      ? null
      : loadDeployment(
        chainId,
        "MurmurEscrow",
        manifest ?? undefined,
      )?.address ?? null;
  return {
    sealedVerdictsAddress: resolveFhenixContractAddress(chainId, env),
    escrowAddress: envEscrowAddress ?? manifestEscrowAddress,
  };
}

function addressFromEnv(raw: string | undefined, key: string): string | null {
  const parsed = parseFhenixAddressInput(raw);
  if (parsed.kind === "empty") return null;
  if (parsed.kind === "address") return parsed.address;
  throw new FhenixDeploymentConfigError(
    key,
    "must be a 20-byte 0x-prefixed address",
  );
}
