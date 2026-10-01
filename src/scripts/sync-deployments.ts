import "dotenv/config";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readManifest, manifestPath, type DeploymentEntry } from "../integrations/deployments.js";
import {
  buildDeploymentSyncPlan,
  formatDeploymentSyncAppendLine,
  formatDeploymentSyncLatestLine,
  formatDeploymentSyncReadLine,
  patchDeploymentEnvBody,
  renderDeploymentSyncHelp,
  serializeDeploymentManifest,
  type DeploymentSyncBroadcastSource,
} from "../integrations/deployment-sync-surface.js";

const CHAIN_ID = Number(process.env.SYNC_CHAIN_ID ?? "421614");
const BROADCAST_ROOT = join(process.cwd(), "contracts", "broadcast");

/// Forge writes per-script directories: contracts/broadcast/<Script>.s.sol/<chainId>/run-latest.json
function findBroadcastFiles(chainId: number): string[] {
  if (!existsSync(BROADCAST_ROOT)) return [];
  const out: string[] = [];
  for (const scriptDir of readdirSync(BROADCAST_ROOT)) {
    const chainDir = join(BROADCAST_ROOT, scriptDir, String(chainId));
    const runLatest = join(chainDir, "run-latest.json");
    if (existsSync(runLatest)) out.push(runLatest);
  }
  return out;
}

function patchEnv(latest: Map<string, DeploymentEntry>, envPath = ".env"): void {
  if (!existsSync(envPath)) {
    console.log(`[sync] no ${envPath}, skipping patch`);
    return;
  }
  copyFileSync(envPath, envPath + ".bak");
  const patch = patchDeploymentEnvBody({
    body: readFileSync(envPath, "utf8"),
    latest,
  });
  writeFileSync(envPath, patch.body);
  console.log(`[sync] patched ${envPath} (backup at ${envPath}.bak)`);
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(renderDeploymentSyncHelp());
    return;
  }

  const broadcastFiles = findBroadcastFiles(CHAIN_ID);
  if (broadcastFiles.length === 0) {
    console.error(`[sync] no broadcast files for chain ${CHAIN_ID} under ${BROADCAST_ROOT}`);
    process.exit(1);
  }
  const broadcasts: DeploymentSyncBroadcastSource[] = [];
  for (const file of broadcastFiles) {
    const stat = statSync(file);
    const source = {
      path: file,
      raw: readFileSync(file, "utf8"),
      mtime: stat.mtime,
    };
    console.log(formatDeploymentSyncReadLine(source));
    broadcasts.push(source);
  }

  const existing = readManifest();
  const plan = buildDeploymentSyncPlan({
    chainId: CHAIN_ID,
    existing,
    broadcasts,
  });
  for (const warning of plan.warnings) {
    console.warn(`[sync] ${warning}`);
  }
  const manifest = manifestPath();
  if (plan.additions.length > 0) {
    writeFileSync(manifest, serializeDeploymentManifest(plan.merged));
  }
  console.log(formatDeploymentSyncAppendLine({
    additions: plan.additions.length,
    manifestPath: manifest,
  }));

  for (const [name, entry] of plan.latest) {
    console.log(formatDeploymentSyncLatestLine(name, entry));
  }
  patchEnv(plan.latest);
}

main();
