/**
 * Locks the fail-closed reconciler: a proven revert returns null (safe to broadcast);
 * an indeterminate RPC failure propagates so the attempt stays retryable without re-broadcasting.
 */

import assert from "node:assert/strict";

import { ContractFunctionZeroDataError } from "viem";

import type { FhenixGatewayClient } from "./fhenix-gateway-contract.js";
import {
  isProvenContractRevert,
  reconcileSealedCallSubmit,
  type ReconciliationConfig,
  type SealedCallReconciliationKey,
} from "./fhenix-gateway-reconciliation.js";

// ── isProvenContractRevert ────────────────────────────────────────────────
{
  // genuine viem revert-shaped error → proven
  assert.equal(
    isProvenContractRevert(
      new ContractFunctionZeroDataError({ functionName: "getCall" }),
    ),
    true,
    "viem ZeroData revert must classify as a proven revert",
  );

  // name-tagged fake revert (adapters that don't extend BaseError) → proven
  const tagged = Object.assign(new Error("CallNotFound"), {
    name: "ContractFunctionRevertedError",
  });
  assert.equal(
    isProvenContractRevert(tagged),
    true,
    "name-tagged revert must classify as a proven revert",
  );

  // revert nested in a cause chain → proven
  assert.equal(
    isProvenContractRevert(
      Object.assign(new Error("wrapped"), { cause: tagged }),
    ),
    true,
    "revert in the cause chain must classify as a proven revert",
  );

  // transport / timeout / unknown → NOT proven (indeterminate)
  assert.equal(
    isProvenContractRevert(new Error("fetch failed: ECONNRESET")),
    false,
    "plain transport error must be indeterminate",
  );
  assert.equal(
    isProvenContractRevert(
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    ),
    false,
    "timeout must be indeterminate",
  );
  assert.equal(isProvenContractRevert(null), false);
  assert.equal(isProvenContractRevert(undefined), false);
}

// ── reconcileSealedCallSubmit branching ───────────────────────────────────
const KEY: SealedCallReconciliationKey = {
  agentWalletAddress: "0x" + "11".repeat(20),
  marketIdHash: "0x" + "22".repeat(32),
  clientNonce: "0x" + "33".repeat(32),
};

function baseClient(
  readContract: FhenixGatewayClient["readContract"],
): FhenixGatewayClient {
  return {
    getChainId: async () => 84532,
    getBlockNumber: async () => 100n,
    writeContract: async () => {
      throw new Error("writeContract must not run during reconciliation");
    },
    getTransactionReceipt: async () => {
      throw new Error("unused");
    },
    readContract,
    getLogs: async () => {
      throw new Error("getLogs must not run when the id is absent");
    },
  };
}

function config(client: FhenixGatewayClient): ReconciliationConfig {
  return {
    client,
    chainId: 84532,
    contractAddress: "0x" + "44".repeat(20),
    reconcileFromBlock: 0,
  };
}

// proven revert → null (safe to broadcast), getLogs never consulted
{
  const client = baseClient(async () => {
    throw Object.assign(new Error("CallNotFound"), {
      name: "ContractFunctionRevertedError",
    });
  });
  const result = await reconcileSealedCallSubmit(config(client), KEY);
  assert.equal(result, null, "proven revert must reconcile to null");
}

// indeterminate RPC failure → THROWS (do not broadcast)
{
  const client = baseClient(async () => {
    throw new Error("fetch failed: socket hang up");
  });
  await assert.rejects(
    () => reconcileSealedCallSubmit(config(client), KEY),
    /socket hang up/,
    "indeterminate RPC failure must propagate, not return null",
  );
}

console.log("fhenix-gateway-reconciliation smoke: ok");
