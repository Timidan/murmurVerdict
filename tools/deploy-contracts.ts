import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { deriveAddressFromKey } from "../src/integrations/derived-addresses.js";

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== "--broadcast")) throw new Error("Only --broadcast is supported; no flag means simulation.");
const rpc = process.env.FHENIX_RPC_URL;
if (!rpc) throw new Error("FHENIX_RPC_URL is required");
if (!process.env.DEPLOY_PRIVATE_KEY) throw new Error("DEPLOY_PRIVATE_KEY is required");
const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
if (await client.getChainId() !== arbitrumSepolia.id) throw new Error("RPC must serve Arbitrum Sepolia (421614)");

const env = { ...process.env };
for (const [name, keyName] of [
  ["RELAYER_ADDRESS", "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY"],
  ["GRANTOR_ADDRESS", "FHENIX_GRANT_PRIVATE_KEY"],
  ["REVEAL_ADDRESS", "FHENIX_REVEAL_PRIVATE_KEY"],
] as const) {
  const key = env[keyName];
  if (!key) throw new Error(`${keyName} is required`);
  env[name] = deriveAddressFromKey({ privateKey: key, configured: env[name], configuredName: name, keyName });
}
const installedForge = join(homedir(), ".foundry/bin/forge");
const result = spawnSync(existsSync(installedForge) ? installedForge : "forge", [
  "script", "contracts/script/DeployMurmurSealedVerdicts.s.sol:DeployMurmurSealedVerdicts",
  "--root", "contracts", "--rpc-url", rpc, "--chain", String(arbitrumSepolia.id), ...flags,
], { env, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
