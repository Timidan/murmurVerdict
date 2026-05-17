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

export function manifestPath(): string {
  return (
    process.env.DEPLOYMENTS_MANIFEST_PATH ??
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
