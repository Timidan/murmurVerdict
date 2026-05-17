import { createPublicClient, http, getAddress, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { loadDeployment } from "../integrations/deployments.js";

const CHAIN_ID = 84532;
const EXPECTED_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");

const VERDICTS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function relayers(address) view returns (bool)",
]);
const ESCROW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function USDC() view returns (address)",
  "function protocolFeeSink() view returns (address)",
]);

async function main() {
  const rawOwner = process.env.AGENT_ADDRESS;
  if (!rawOwner) {
    console.error("AGENT_ADDRESS unset");
    process.exit(1);
  }
  const EXPECTED_OWNER = getAddress(rawOwner);

  const rpc = process.env.FHENIX_RPC_URL || process.env.BASE_RPC_URL;
  if (!rpc) {
    console.error("FHENIX_RPC_URL or BASE_RPC_URL must be set");
    process.exit(1);
  }

  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });

  let failures = 0;
  function assertEq(label: string, actual: string, expected: string) {
    if (getAddress(actual) !== getAddress(expected)) {
      console.error(`✗ ${label}: got ${actual}, expected ${expected}`);
      failures++;
    } else {
      console.log(`✓ ${label}: ${actual}`);
    }
  }

  const verdicts = loadDeployment(CHAIN_ID, "MurmurSealedVerdicts");
  const escrow = loadDeployment(CHAIN_ID, "MurmurEscrow");
  if (!verdicts || !escrow) {
    console.error("manifest missing one or both contracts");
    process.exit(1);
  }

  console.log(`[verify] MurmurSealedVerdicts @ ${verdicts.address}`);
  const vOwner = await client.readContract({
    address: getAddress(verdicts.address), abi: VERDICTS_ABI, functionName: "owner",
  });
  const vRelayer = await client.readContract({
    address: getAddress(verdicts.address), abi: VERDICTS_ABI, functionName: "relayers", args: [EXPECTED_OWNER],
  });
  assertEq("verdicts.owner", vOwner, EXPECTED_OWNER);
  if (!vRelayer) { console.error(`✗ verdicts.relayers(${EXPECTED_OWNER}) = false`); failures++; }
  else { console.log(`✓ verdicts.relayers(${EXPECTED_OWNER}) = true`); }

  console.log(`[verify] MurmurEscrow @ ${escrow.address}`);
  const eOwner = await client.readContract({
    address: getAddress(escrow.address), abi: ESCROW_ABI, functionName: "owner",
  });
  const eUsdc = await client.readContract({
    address: getAddress(escrow.address), abi: ESCROW_ABI, functionName: "USDC",
  });
  const eSink = await client.readContract({
    address: getAddress(escrow.address), abi: ESCROW_ABI, functionName: "protocolFeeSink",
  });
  assertEq("escrow.owner", eOwner, EXPECTED_OWNER);
  assertEq("escrow.USDC", eUsdc, EXPECTED_USDC);
  assertEq("escrow.protocolFeeSink", eSink, EXPECTED_OWNER);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch(err => { console.error(err); process.exit(1); });
