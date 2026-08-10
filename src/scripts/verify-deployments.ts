import "dotenv/config";
import { createPublicClient, http, getAddress, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { loadDeployment } from "../integrations/deployments.js";
import { deriveAddressFromKey } from "../integrations/derived-addresses.js";

const CHAIN_ID = 84532;
const EXPECTED_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");

const VERDICTS_ABI = parseAbi([
  "function owner() view returns (address)",
  "function relayers(address) view returns (bool)",
  "function grantors(address) view returns (bool)",
  // Six-instant schedule shape. A pre-redesign deployment answers this with
  // three words instead of seven, which is the ONE check that distinguishes a
  // stale manifest entry from a healthy one — every role check above passes
  // against the old contract.
  "function markets(bytes32) view returns (uint64 armCloseAt, uint64 submissionOpenAt, uint64 earlyAccessCutoffAt, uint64 submissionCloseAt, uint64 resolutionAt, uint64 publicRevealAt, bool active)",
]);
const ESCROW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function USDC() view returns (address)",
  "function protocolFeeSink() view returns (address)",
]);

async function main() {
  // Derived from the relayer key, not configured. AGENT_ADDRESS is optional
  // now — set it only if you want the check to be explicit, and it must then
  // agree with the key.
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

  // The grantor role is what paid decrypt-grants run on, and it is deliberately
  // a DIFFERENT key from the relayer. Unverified, a deploy can look healthy
  // while every grant reverts NotGrantor after the subscriber has paid.
  // Same rule: the grant key determines the grantor address.
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
    // Fail, do not skip. Skipping here printed a green verification for a
    // deployment whose paid-grant path cannot work; the daemon then refuses to
    // start, after the operator has already been told the deploy is good.
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

  // ABI SHAPE, not just roles. The manifest can point at a contract that is
  // owned correctly and staffed correctly and still be the WRONG REVISION —
  // and nothing else in this script or in verify:readiness would notice,
  // because the offline suite never touches a live address. The daemon then
  // fails at runtime with LegacyContractError on the first discovery tick.
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
