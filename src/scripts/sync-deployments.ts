import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, manifestPath, type DeploymentEntry } from "../integrations/deployments.js";

const CHAIN_ID = Number(process.env.SYNC_CHAIN_ID ?? "84532");
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

function entriesFromBroadcast(path: string, chainId: number): DeploymentEntry[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as ForgeBroadcast;
  const blockByHash = new Map(data.receipts.map(r => [r.transactionHash, parseInt(r.blockNumber, 16)]));
  const deployedAt = new Date(data.timestamp * 1000).toISOString();
  const out: DeploymentEntry[] = [];
  for (const tx of data.transactions) {
    if (tx.transactionType !== "CREATE" && tx.transactionType !== "CREATE2") continue;
    if (!tx.contractName || !tx.contractAddress) continue;
    out.push({
      chainId,
      contractName: tx.contractName,
      address: tx.contractAddress,
      deployedAt,
      txHash: tx.hash,
      blockNumber: blockByHash.get(tx.hash) ?? 0,
    });
  }
  return out;
}

function dedupeKey(e: DeploymentEntry) {
  return `${e.chainId}:${e.contractName}:${e.txHash}`;
}

const ENV_KEYS_BY_CONTRACT: Record<string, string> = {
  MurmurSealedVerdicts: "FHENIX_SEALED_VERDICTS_ADDRESS",
  MurmurEscrow: "FHENIX_ESCROW_ADDRESS",
};

function patchEnv(latest: Map<string, DeploymentEntry>, envPath = ".env"): void {
  if (!existsSync(envPath)) {
    console.log(`[sync] no ${envPath}, skipping patch`);
    return;
  }
  copyFileSync(envPath, envPath + ".bak");
  let body = readFileSync(envPath, "utf8");
  for (const [contractName, envKey] of Object.entries(ENV_KEYS_BY_CONTRACT)) {
    const entry = latest.get(contractName);
    if (!entry) continue;
    const line = `${envKey}=${entry.address}`;
    if (body.match(new RegExp(`^${envKey}=.*$`, "m"))) {
      body = body.replace(new RegExp(`^${envKey}=.*$`, "m"), line);
    } else {
      body += (body.endsWith("\n") ? "" : "\n") + line + "\n";
    }
  }
  writeFileSync(envPath, body);
  console.log(`[sync] patched ${envPath} (backup at ${envPath}.bak)`);
}

function main() {
  const broadcastFiles = findBroadcastFiles(CHAIN_ID);
  if (broadcastFiles.length === 0) {
    console.error(`[sync] no broadcast files for chain ${CHAIN_ID} under ${BROADCAST_ROOT}`);
    process.exit(1);
  }
  const existing = readManifest();
  const seen = new Set(existing.map(dedupeKey));
  const additions: DeploymentEntry[] = [];
  for (const file of broadcastFiles) {
    const stat = statSync(file);
    console.log(`[sync] reading ${file} (mtime ${stat.mtime.toISOString()})`);
    for (const entry of entriesFromBroadcast(file, CHAIN_ID)) {
      if (seen.has(dedupeKey(entry))) continue;
      seen.add(dedupeKey(entry));
      additions.push(entry);
    }
  }
  if (additions.length === 0) {
    console.log("[sync] nothing new to append");
  } else {
    const merged = [...existing, ...additions];
    writeFileSync(manifestPath(), JSON.stringify(merged, null, 2) + "\n");
    console.log(`[sync] appended ${additions.length} entries to ${manifestPath()}`);
  }

  const latest = new Map<string, DeploymentEntry>();
  for (const entry of readManifest().filter(e => e.chainId === CHAIN_ID)) {
    const prev = latest.get(entry.contractName);
    if (!prev || Date.parse(entry.deployedAt) > Date.parse(prev.deployedAt)) {
      latest.set(entry.contractName, entry);
    }
  }
  for (const [name, entry] of latest) {
    console.log(`  ${name.padEnd(28)} ${entry.address}  block ${entry.blockNumber}  ${entry.deployedAt}`);
  }
  patchEnv(latest);
}

main();
