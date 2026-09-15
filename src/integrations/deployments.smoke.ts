import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FhenixDeploymentConfigError,
  loadDeployment,
  manifestPath,
  parseFhenixAddressInput,
  parseFhenixChainIdInput,
  readManifest,
  resolveFhenixChainId,
  resolveFhenixContractAddress,
  resolveFhenixDeploymentAddresses,
} from "./deployments.js";

const tmp = mkdtempSync(join(tmpdir(), "murmur-deployments-smoke-"));
const path = join(tmp, "deployments.json");
const sealedOld = `0x${"1".repeat(40)}`;
const sealedNew = `0x${"2".repeat(40)}`;
const escrowOld = `0x${"3".repeat(40)}`;
const escrowNew = `0x${"4".repeat(40)}`;
const overrideSealed = `0x${"5".repeat(40)}`;
const overrideEscrow = `0x${"6".repeat(40)}`;
const legacySealed = `0x${"7".repeat(40)}`;

try {
  writeFileSync(
    path,
    JSON.stringify([
      entry("MurmurSealedVerdicts", sealedOld, "2026-05-14T00:00:00Z", 10),
      entry("MurmurEscrow", escrowOld, "2026-05-14T00:00:00Z", 11),
      entry("MurmurSealedVerdicts", sealedNew, "2026-05-15T00:00:00Z", 12),
      entry("MurmurEscrow", escrowNew, "2026-05-15T00:00:00Z", 13),
    ]),
  );

  const env = { DEPLOYMENTS_MANIFEST_PATH: path };
  assert.equal(manifestPath(env), path);
  assert.deepEqual(parseFhenixAddressInput(""), { kind: "empty" });
  assert.deepEqual(parseFhenixAddressInput(` ${overrideSealed} `), {
    kind: "address",
    address: overrideSealed,
  });
  assert.deepEqual(parseFhenixAddressInput("not-an-address"), {
    kind: "invalid",
    raw: "not-an-address",
  });
  assert.deepEqual(parseFhenixChainIdInput(""), { kind: "empty" });
  assert.deepEqual(parseFhenixChainIdInput(" 84532 "), {
    kind: "chain_id",
    chainId: 84532,
  });
  assert.deepEqual(parseFhenixChainIdInput("0"), {
    kind: "invalid",
    raw: "0",
  });
  // Chain id derives from the manifest, so pin isolated manifests, not the repo's real one.
  const emptyManifest = join(tmp, "chainid-empty.json");
  writeFileSync(emptyManifest, "[]");
  const oneChainManifest = join(tmp, "chainid-one.json");
  writeFileSync(
    oneChainManifest,
    JSON.stringify([
      {
        chainId: 84532,
        contractName: "MurmurSealedVerdicts",
        address: `0x${"a".repeat(40)}`,
        deployedAt: "2026-08-05T00:00:00.000Z",
        txHash: `0x${"b".repeat(64)}`,
        blockNumber: 1,
      },
    ]),
  );

  assert.equal(
    resolveFhenixChainId({ FHENIX_CHAIN_ID: " 84532 ", DEPLOYMENTS_MANIFEST_PATH: oneChainManifest }),
    84532,
    "an explicit value that agrees with the manifest is accepted",
  );
  assert.equal(
    resolveFhenixChainId({ DEPLOYMENTS_MANIFEST_PATH: oneChainManifest }),
    84532,
    "unset derives the manifest's only chain",
  );
  assert.equal(
    resolveFhenixChainId({ DEPLOYMENTS_MANIFEST_PATH: emptyManifest }),
    null,
    "nothing to derive from, and nothing set",
  );
  assert.throws(
    () =>
      resolveFhenixChainId({
        FHENIX_CHAIN_ID: "1",
        DEPLOYMENTS_MANIFEST_PATH: oneChainManifest,
      }),
    /Refusing to guess/,
    "a value contradicting a single-chain manifest is refused, not resolved",
  );
  assert.throws(
    () => resolveFhenixChainId({ FHENIX_CHAIN_ID: "not-a-chain" }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_CHAIN_ID",
  );
  assert.equal(readManifest(join(tmp, "missing.json")).length, 0);
  assert.equal(
    loadDeployment(84532, "MurmurSealedVerdicts", path)?.address,
    sealedNew,
  );
  assert.deepEqual(resolveFhenixDeploymentAddresses(84532, env), {
    sealedVerdictsAddress: sealedNew,
    escrowAddress: escrowNew,
  });
  assert.deepEqual(resolveFhenixDeploymentAddresses(84532, {
    ...env,
    FHENIX_SEALED_VERDICTS_ADDRESS: overrideSealed,
    FHENIX_ESCROW_ADDRESS: overrideEscrow,
  }), {
    sealedVerdictsAddress: overrideSealed,
    escrowAddress: overrideEscrow,
  });
  // FHENIX_CONTRACT_ADDRESS is ignored; the manifest answers.
  assert.notEqual(
    resolveFhenixContractAddress(84532, { ...env, FHENIX_CONTRACT_ADDRESS: legacySealed }),
    legacySealed,
    "the legacy alias must no longer override the manifest",
  );
  assert.throws(
    () => resolveFhenixDeploymentAddresses(84532, {
      ...env,
      FHENIX_ESCROW_ADDRESS: "not-an-address",
    }),
    (err) =>
      err instanceof FhenixDeploymentConfigError &&
      err.key === "FHENIX_ESCROW_ADDRESS",
  );
  assert.deepEqual(resolveFhenixDeploymentAddresses(undefined, env), {
    sealedVerdictsAddress: null,
    escrowAddress: null,
  });

  console.log("deployments smoke ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function entry(
  contractName: string,
  address: string,
  deployedAt: string,
  blockNumber: number,
) {
  return {
    chainId: 84532,
    contractName,
    address,
    deployedAt,
    txHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    blockNumber,
  };
}
