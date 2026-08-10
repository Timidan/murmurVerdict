import assert from "node:assert/strict";

import {
  DeploymentSyncError,
  buildDeploymentSyncPlan,
  deploymentSyncDedupeKey,
  entriesFromForgeBroadcast,
  formatDeploymentSyncAppendLine,
  formatDeploymentSyncLatestLine,
  formatDeploymentSyncReadLine,
  latestDeploymentsByContract,
  patchDeploymentEnvBody,
  renderDeploymentSyncHelp,
  serializeDeploymentManifest,
} from "./deployment-sync-surface.js";
import type { DeploymentEntry } from "./deployments.js";

process.stdout.write("murmur deployment sync surface smoke\n");

const chainId = 84532;
const existing = deploymentEntry({
  contractName: "MurmurSealedVerdicts",
  address: `0x${"1".repeat(40)}`,
  txHash: `0x${"a".repeat(64)}`,
  deployedAt: "2026-05-01T00:00:00.000Z",
  blockNumber: 1,
});
const newerSealed = deploymentEntry({
  contractName: "MurmurSealedVerdicts",
  address: `0x${"2".repeat(40)}`,
  txHash: `0x${"b".repeat(64)}`,
  deployedAt: "2026-05-28T12:00:00.000Z",
  blockNumber: 16,
});
const escrow = deploymentEntry({
  contractName: "MurmurEscrow",
  address: `0x${"3".repeat(40)}`,
  txHash: `0x${"c".repeat(64)}`,
  deployedAt: "2026-05-28T12:00:00.000Z",
  blockNumber: 0,
});

const extraction = entriesFromForgeBroadcast({
  chainId,
  source: "contracts/broadcast/Deploy.s.sol/84532/run-latest.json",
  raw: forgeBroadcastRaw([
    {
      hash: newerSealed.txHash,
      contractName: newerSealed.contractName,
      contractAddress: newerSealed.address,
      transactionType: "CREATE",
    },
    {
      hash: escrow.txHash,
      contractName: escrow.contractName,
      contractAddress: escrow.address,
      transactionType: "CREATE2",
    },
    {
      hash: `0x${"d".repeat(64)}`,
      contractName: "IgnoredCall",
      contractAddress: `0x${"4".repeat(40)}`,
      transactionType: "CALL",
    },
    {
      hash: `0x${"e".repeat(64)}`,
      contractName: null,
      contractAddress: `0x${"5".repeat(40)}`,
      transactionType: "CREATE",
    },
  ], [{ transactionHash: newerSealed.txHash, blockNumber: "0x10" }]),
});
assert.deepEqual(extraction.entries, [newerSealed, escrow]);
assert.deepEqual(extraction.warnings, [
  `no receipt for tx ${escrow.txHash} in contracts/broadcast/Deploy.s.sol/84532/run-latest.json, using blockNumber=0`,
]);

const plan = buildDeploymentSyncPlan({
  chainId,
  existing: [existing, newerSealed],
  broadcasts: [
    {
      path: "contracts/broadcast/Deploy.s.sol/84532/run-latest.json",
      raw: forgeBroadcastRaw([
        {
          hash: newerSealed.txHash,
          contractName: newerSealed.contractName,
          contractAddress: newerSealed.address,
          transactionType: "CREATE",
        },
        {
          hash: escrow.txHash,
          contractName: escrow.contractName,
          contractAddress: escrow.address,
          transactionType: "CREATE2",
        },
      ], [{ transactionHash: newerSealed.txHash, blockNumber: "0x10" }]),
    },
  ],
});
assert.deepEqual(plan.additions, [escrow]);
assert.deepEqual(plan.merged, [existing, newerSealed, escrow]);
assert.equal(
  plan.latest.get("MurmurSealedVerdicts")?.address,
  newerSealed.address,
);
assert.equal(plan.latest.get("MurmurEscrow")?.address, escrow.address);
assert.equal(deploymentSyncDedupeKey(escrow), `${chainId}:MurmurEscrow:${escrow.txHash}`);

assert.deepEqual(latestDeploymentsByContract([
  existing,
  newerSealed,
  { ...escrow, chainId: 1 },
], chainId), new Map([["MurmurSealedVerdicts", newerSealed]]));

// EVERY alias for a contract is patched, not just the primary.
// resolveFhenixContractAddress falls back from FHENIX_SEALED_VERDICTS_ADDRESS
// to the legacy FHENIX_CONTRACT_ADDRESS, so patching one left the other
// pointing at a dead deployment — harmless while the primary is set, and a
// live trap the moment it is cleared. Observed for real on a redeploy.
const envPatch = patchDeploymentEnvBody({
  body: [
    "BASE_RPC_URL=https://base.example",
    `FHENIX_SEALED_VERDICTS_ADDRESS=0x${"9".repeat(40)}`,
    "OTHER=value",
  ].join("\n"),
  latest: plan.latest,
});
// One key per contract. The block-number keys and the FHENIX_CONTRACT_ADDRESS
// alias were deleted: both shadowed data/deployments.json, which is the thing
// this tool maintains, so a stale copy could outlive a redeploy.
assert.deepEqual(envPatch.patchedKeys, [
  "FHENIX_SEALED_VERDICTS_ADDRESS",
  "FHENIX_ESCROW_ADDRESS",
]);
assert.equal(
  envPatch.body,
  [
    "BASE_RPC_URL=https://base.example",
    "OTHER=value",
    `FHENIX_SEALED_VERDICTS_ADDRESS=${newerSealed.address}`,
    `FHENIX_ESCROW_ADDRESS=${escrow.address}`,
    "",
  ].join("\n"),
);

assert.match(serializeDeploymentManifest([escrow]), /\n$/);
assert.equal(
  formatDeploymentSyncReadLine({
    path: "run-latest.json",
    raw: "{}",
    mtime: new Date("2026-05-28T12:34:56.000Z"),
  }),
  "[sync] reading run-latest.json (mtime 2026-05-28T12:34:56.000Z)",
);
assert.equal(
  formatDeploymentSyncAppendLine({ additions: 0, manifestPath: "data/deployments.json" }),
  "[sync] nothing new to append",
);
assert.equal(
  formatDeploymentSyncAppendLine({ additions: 2, manifestPath: "data/deployments.json" }),
  "[sync] appended 2 entries to data/deployments.json",
);
assert.equal(
  formatDeploymentSyncLatestLine("MurmurEscrow", escrow),
  `  MurmurEscrow                 ${escrow.address}  block 0  ${escrow.deployedAt}`,
);
assert.match(renderDeploymentSyncHelp(), /SYNC_CHAIN_ID/);
assert.throws(
  () => entriesFromForgeBroadcast({ chainId, source: "bad.json", raw: "{" }),
  (err) => err instanceof DeploymentSyncError && err.source === "bad.json",
);

process.stdout.write("deployment sync surface smoke ok\n");

function deploymentEntry(input: {
  contractName: string;
  address: string;
  txHash: string;
  deployedAt: string;
  blockNumber: number;
}): DeploymentEntry {
  return {
    chainId,
    ...input,
  };
}

function forgeBroadcastRaw(
  transactions: Array<{
    hash: string;
    contractName: string | null;
    contractAddress: string | null;
    transactionType: string;
  }>,
  receipts: Array<{ transactionHash: string; blockNumber: string }>,
): string {
  return JSON.stringify({
    transactions,
    receipts,
    timestamp: Date.parse("2026-05-28T12:00:00.000Z"),
  });
}
