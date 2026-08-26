import { strict as assert } from "node:assert";
import {
  createHash,
  generateKeyPairSync,
  verify,
} from "node:crypto";

import {
  addressOnlyWalletClient,
  buildAgentSealedCallBody,
  buildGatewayPopHeaders,
  cofheVerifierError,
} from "./agent-side-cofhe-sealer-support.js";

process.stdout.write("agent-side CoFHE sealer support smoke\n");

const relayer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const wallet = addressOnlyWalletClient(relayer);
assert.equal(wallet.account?.address, relayer);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingPrivateKey = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const bodyBytes = Buffer.from('{"privacy_mode":"sealed_fhenix"}', "utf8");
const headers = buildGatewayPopHeaders({
  audience: "murmur-smoke",
  bodyBytes,
  nonce: "ab".repeat(16),
  runtimeKey: "mrt_smoke",
  runtimeKeyId: "rk_smoke",
  signingPrivateKey,
  timestamp: 1_777_777_777,
});
const signingString = [
  "murmur-rk-v2",
  "murmur-smoke",
  "rk_smoke",
  "1777777777",
  "ab".repeat(16),
  "POST",
  "/v2/gateway/calls",
  createHash("sha256").update(bodyBytes).digest("hex"),
].join("\n");
assert.equal(headers["X-Murmur-Runtime-Key"], "mrt_smoke");
assert.equal(
  verify(
    null,
    Buffer.from(signingString, "utf8"),
    publicKey,
    Buffer.from(headers["X-Murmur-Key-Signature"]!, "hex"),
  ),
  true,
);

const sealedBody = buildAgentSealedCallBody({
  binaryInput: {
    ct_hash: `0x${"11".repeat(32)}`,
    security_zone: 0,
    utype: 2,
    signature: "0x1234",
  },
  clientNonce: `0x${"33".repeat(32)}`,
  clientOrderId: "operator-blind-smoke",
  confidenceInput: {
    ct_hash: `0x${"22".repeat(32)}`,
    security_zone: 0,
    utype: 3,
    signature: "0x5678",
  },
  configVersion: 7,
  marketSourceId: "market-smoke",
  strategyTag: "local-seal",
});
const serializedBody = JSON.stringify(sealedBody);
assert.equal(sealedBody.privacy_mode, "sealed_fhenix");
assert.equal(sealedBody.binary_index_input.utype, 2);
assert.equal(sealedBody.confidence_input.utype, 3);
assert.doesNotMatch(serializedBody, /"verdict"|"binary_index"|"confidence_bps"/);

const unavailable = Object.assign(new Error("ZK proof verification failed"), {
  code: "ZK_VERIFY_FAILED",
  cause: new Error("HTTP 404 Not Found from /verify"),
});
assert.match(
  cofheVerifierError(unavailable).message,
  /CoFHE verifier is unreachable.*HTTP 404.*no plaintext was sent to Murmur/i,
);
const rejected = cofheVerifierError({
  code: "ZK_VERIFY_FAILED",
  message: "verification key not found",
}).message;
assert.doesNotMatch(rejected, /verifier is unreachable/i);
assert.match(rejected, /proof or verifier response may be invalid/i);

process.stdout.write("agent-side CoFHE sealer support smoke ok\n");
