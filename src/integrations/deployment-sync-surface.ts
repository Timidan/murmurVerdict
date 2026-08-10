import type { DeploymentEntry } from "./deployments.js";

/**
 * One contract can back SEVERAL env keys. `resolveFhenixContractAddress` falls
 * back from FHENIX_SEALED_VERDICTS_ADDRESS to the legacy
 * FHENIX_CONTRACT_ADDRESS, so patching only the primary left the alias
 * pointing at a DEAD deployment: correct today because the primary wins, and a
 * trap the moment anyone clears or comments it out.
 */
/**
 * Contract → env keys holding a BLOCK NUMBER.
 *
 * Empty, deliberately. FHENIX_EVENT_START_BLOCK and
 * FHENIX_GATEWAY_RECONCILE_FROM_BLOCK used to live here; both were deleted in
 * favour of reading the manifest directly. Syncing a var that shadows the
 * manifest is a worse fix than not having the var — the value can still go
 * stale between a redeploy and the next sync.
 *
 * Kept as a seam: if a future contract genuinely needs a block pinned in env,
 * add it here and the patcher already handles it.
 */
export const MURMUR_DEPLOYMENT_BLOCK_ENV_KEYS_BY_CONTRACT: Record<string, string[]> = {};

export const MURMUR_DEPLOYMENT_ENV_KEYS_BY_CONTRACT: Record<string, string[]> = {
  // One name per value. FHENIX_CONTRACT_ADDRESS was a second alias for the
  // same deployment and has been removed from the resolver entirely.
  MurmurSealedVerdicts: ["FHENIX_SEALED_VERDICTS_ADDRESS"],
  MurmurEscrow: ["FHENIX_ESCROW_ADDRESS"],
};

export interface DeploymentSyncBroadcastSource {
  path: string;
  raw: string;
  mtime?: Date;
}

export interface DeploymentSyncPlan {
  additions: DeploymentEntry[];
  merged: DeploymentEntry[];
  latest: Map<string, DeploymentEntry>;
  warnings: string[];
}

export interface DeploymentEnvPatch {
  body: string;
  patchedKeys: string[];
}

interface ForgeTx {
  hash: string;
  contractName: string | null;
  contractAddress: string | null;
  transactionType: string;
}

interface ForgeBroadcast {
  transactions: ForgeTx[];
  receipts: Array<{ transactionHash: string; blockNumber: string }>;
  timestamp: number;
}

export class DeploymentSyncError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = "DeploymentSyncError";
    this.source = source;
  }
}

export function buildDeploymentSyncPlan(input: {
  chainId: number;
  existing: DeploymentEntry[];
  broadcasts: DeploymentSyncBroadcastSource[];
}): DeploymentSyncPlan {
  const seen = new Set(input.existing.map(deploymentSyncDedupeKey));
  const additions: DeploymentEntry[] = [];
  const warnings: string[] = [];

  for (const source of input.broadcasts) {
    const extracted = entriesFromForgeBroadcast({
      raw: source.raw,
      source: source.path,
      chainId: input.chainId,
    });
    warnings.push(...extracted.warnings);
    for (const entry of extracted.entries) {
      const key = deploymentSyncDedupeKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(entry);
    }
  }

  const merged = [...input.existing, ...additions];
  return {
    additions,
    merged,
    latest: latestDeploymentsByContract(merged, input.chainId),
    warnings,
  };
}

export function entriesFromForgeBroadcast(input: {
  raw: string;
  source: string;
  chainId: number;
}): { entries: DeploymentEntry[]; warnings: string[] } {
  const data = parseForgeBroadcast(input.raw, input.source);
  const blockByHash = new Map(
    data.receipts.map((r) => [
      r.transactionHash,
      Number.parseInt(r.blockNumber, 16),
    ]),
  );
  const deployedAt = new Date(data.timestamp).toISOString();
  const entries: DeploymentEntry[] = [];
  const warnings: string[] = [];

  for (const tx of data.transactions) {
    if (tx.transactionType !== "CREATE" && tx.transactionType !== "CREATE2") {
      continue;
    }
    if (!tx.contractName || !tx.contractAddress) continue;
    const blockNumber = blockByHash.get(tx.hash);
    if (blockNumber === undefined) {
      warnings.push(
        `no receipt for tx ${tx.hash} in ${input.source}, using blockNumber=0`,
      );
    }
    entries.push({
      chainId: input.chainId,
      contractName: tx.contractName,
      address: tx.contractAddress,
      deployedAt,
      txHash: tx.hash,
      blockNumber: blockNumber ?? 0,
    });
  }

  return { entries, warnings };
}

export function deploymentSyncDedupeKey(entry: DeploymentEntry): string {
  return `${entry.chainId}:${entry.contractName}:${entry.txHash}`;
}

export function latestDeploymentsByContract(
  entries: DeploymentEntry[],
  chainId: number,
): Map<string, DeploymentEntry> {
  const latest = new Map<string, DeploymentEntry>();
  for (const entry of entries.filter((e) => e.chainId === chainId)) {
    const prev = latest.get(entry.contractName);
    if (!prev || Date.parse(entry.deployedAt) > Date.parse(prev.deployedAt)) {
      latest.set(entry.contractName, entry);
    }
  }
  return latest;
}

export function patchDeploymentEnvBody(input: {
  body: string;
  latest: Map<string, DeploymentEntry>;
  envKeysByContract?: Record<string, string[]>;
  blockEnvKeysByContract?: Record<string, string[]>;
}): DeploymentEnvPatch {
  const envKeysByContract =
    input.envKeysByContract ?? MURMUR_DEPLOYMENT_ENV_KEYS_BY_CONTRACT;
  let body = input.body;
  const patchedKeys: string[] = [];

  const blockKeysByContract =
    input.blockEnvKeysByContract ?? MURMUR_DEPLOYMENT_BLOCK_ENV_KEYS_BY_CONTRACT;

  for (const [contractName, envKeys] of Object.entries(blockKeysByContract)) {
    const entry = input.latest.get(contractName);
    if (!entry || typeof entry.blockNumber !== "number") continue;
    for (const envKey of envKeys) {
      const line = `${envKey}=${entry.blockNumber}`;
      const matcher = new RegExp(`^${escapeRegExp(envKey)}=.*$\r?\n?`, "gm");
      body = body.replace(matcher, "");
      if (!body.endsWith("\n") && body.length > 0) body += "\n";
      body += `${line}\n`;
      patchedKeys.push(envKey);
    }
  }

  for (const [contractName, envKeys] of Object.entries(envKeysByContract)) {
    const entry = input.latest.get(contractName);
    if (!entry) continue;
    for (const envKey of envKeys) {
      const line = `${envKey}=${entry.address}`;
      const matcher = new RegExp(`^${escapeRegExp(envKey)}=.*$\\r?\\n?`, "gm");
      body = body.replace(matcher, "");
      if (!body.endsWith("\n") && body.length > 0) body += "\n";
      body += `${line}\n`;
      patchedKeys.push(envKey);
    }
  }

  return { body, patchedKeys };
}

export function serializeDeploymentManifest(entries: DeploymentEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export function formatDeploymentSyncReadLine(
  source: DeploymentSyncBroadcastSource,
): string {
  const mtime = source.mtime ? ` (mtime ${source.mtime.toISOString()})` : "";
  return `[sync] reading ${source.path}${mtime}`;
}

export function formatDeploymentSyncAppendLine(input: {
  additions: number;
  manifestPath: string;
}): string {
  if (input.additions === 0) return "[sync] nothing new to append";
  return `[sync] appended ${input.additions} entries to ${input.manifestPath}`;
}

export function formatDeploymentSyncLatestLine(
  name: string,
  entry: DeploymentEntry,
): string {
  return `  ${name.padEnd(28)} ${entry.address}  block ${entry.blockNumber}  ${entry.deployedAt}`;
}

export function renderDeploymentSyncHelp(): string {
  return [
    "Usage: tsx src/scripts/sync-deployments.ts",
    "",
    "Reads Forge broadcast run-latest.json files, appends new deployment entries,",
    "prints latest contract addresses, and patches .env Fhenix deployment keys.",
    "",
    "Environment:",
    "  SYNC_CHAIN_ID                Chain id to sync (default: 84532)",
    "  DEPLOYMENTS_MANIFEST_PATH    Manifest path (default: data/deployments.json)",
  ].join("\n");
}

function parseForgeBroadcast(raw: string, source: string): ForgeBroadcast {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DeploymentSyncError(
      source,
      err instanceof Error ? err.message : "invalid JSON",
    );
  }

  if (!isRecord(parsed)) {
    throw new DeploymentSyncError(source, "broadcast must be a JSON object");
  }
  if (!Array.isArray(parsed.transactions)) {
    throw new DeploymentSyncError(source, "broadcast transactions must be an array");
  }
  if (!Array.isArray(parsed.receipts)) {
    throw new DeploymentSyncError(source, "broadcast receipts must be an array");
  }
  if (typeof parsed.timestamp !== "number") {
    throw new DeploymentSyncError(source, "broadcast timestamp must be a number");
  }

  return parsed as unknown as ForgeBroadcast;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
