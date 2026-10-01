import "dotenv/config";
import { createPublicClient, http, getAddress, parseAbi } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { loadDeployment } from "../integrations/deployments.js";
import { deriveAddressFromKey } from "../integrations/derived-addresses.js";

const CHAIN_ID = 421614;
const EXPECTED_USDC = getAddress("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d");

const VERDICTS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function relayers(address) view returns (bool)",
  "function grantors(address) view returns (bool)",
  // Six-instant schedule; the only check that catches a stale contract revision.
  "function markets(bytes32) view returns (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active)",
]);
const ESCROW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function USDC() view returns (address)",
  "function protocolFeeSink() view returns (address)",
]);

async function main() {
  // Derived from the relayer key. AGENT_ADDRESS is optional; if set it must agree.
  const relayerKey = process.env.FHENIX_GATEWAY_RELAYER_PRIVATE_KEY?.trim();
  if (!relayerKey) {
    console.error("FHENIX_GATEWAY_RELAYER_PRIVATE_KEY unset");
    process.exit(1);
  }
  const EXPECTED_OWNER = deriveAddressFromKey({
    privateKey: relayerKey,
    configured: process.env.AGENT_ADDRESS,
    configuredName: "AGENT_ADDRESS",
    keyName: "FHENIX_GATEWAY_RELAYER_PRIVATE_KEY",
  });

  const rpc = process.env.FHENIX_RPC_URL || process.env.ARBITRUM_RPC_URL;
  if (!rpc) {
    console.error("FHENIX_RPC_URL or ARBITRUM_RPC_URL must be set");
    process.exit(1);
  }

  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpc) });
  if (await client.getChainId() !== CHAIN_ID) throw new Error("RPC must serve Arbitrum Sepolia (421614)");

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
  if (!verdicts) {
    console.error("manifest missing MurmurSealedVerdicts on Arbitrum Sepolia");
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

  // Paid grants run on the grantor role, a different key from the relayer; unchecked,
  // every grant reverts NotGrantor after the buyer paid. The grant key sets the address.
  const grantKey = process.env.FHENIX_GRANT_PRIVATE_KEY?.trim();
  const grantorAddress = grantKey
    ? deriveAddressFromKey({
        privateKey: grantKey,
        configured: process.env.GRANTOR_ADDRESS,
        configuredName: "GRANTOR_ADDRESS",
        keyName: "FHENIX_GRANT_PRIVATE_KEY",
      })
    : process.env.GRANTOR_ADDRESS?.trim();
  const grantsEnabled = process.env.FHENIX_GRANT_ENABLED?.trim() === "true";
  if (!grantorAddress && grantsEnabled) {
    // Fail, do not skip: the daemon would refuse to start anyway.
    console.error(
      "✗ FHENIX_GRANT_ENABLED=true but neither FHENIX_GRANT_PRIVATE_KEY nor GRANTOR_ADDRESS is set — the grantor " +
        "role cannot be verified, and paid grants will not work",
    );
    failures++;
  } else if (!grantorAddress) {
    console.log("· GRANTOR_ADDRESS unset and FHENIX_GRANT_ENABLED is not true — skipping grantor role check");
  } else {
    const vGrantor = await client.readContract({
      address: getAddress(verdicts.address), abi: VERDICTS_ABI, functionName: "grantors",
      args: [getAddress(grantorAddress)],
    }) as boolean;
    if (!vGrantor) { console.error(`✗ verdicts.grantors(${grantorAddress}) = false`); failures++; }
    else { console.log(`✓ verdicts.grantors(${grantorAddress}) = true`); }
    if (grantorAddress.toLowerCase() === EXPECTED_OWNER.toLowerCase()) {
      console.error(
        `✗ GRANTOR_ADDRESS equals the relayer/owner — that collapses the role split ` +
        `the contract exists to enforce (the grant signer must not inherit submit authority)`,
      );
      failures++;
    }
  }

  // ABI shape, not just roles: a correctly owned contract can still be the wrong revision.
  try {
    await client.readContract({
      address: getAddress(verdicts.address),
      abi: VERDICTS_ABI,
      functionName: "markets",
      args: [`0x${"00".repeat(32)}`],
    });
    console.log("✓ verdicts.markets(bytes32) returns the six-instant schedule");
  } catch (err) {
    console.error(
      `✗ verdicts.markets(bytes32) does not decode as the six-instant schedule. ` +
        `This deployment predates the six-instant redesign: registerMarket, the ` +
        `submit-event signature, and the acceptance guard are all incompatible. ` +
        `Redeploy MurmurSealedVerdicts and run sync-deployments. (${
          err instanceof Error ? err.message : String(err)
        })`,
    );
    failures++;
  }

  if (escrow) {
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
  } else {
    console.log("· MurmurEscrow not deployed; the x402 flow does not use it");
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch(err => { console.error(err); process.exit(1); });
