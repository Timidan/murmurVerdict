// ─── Gateway snippet templates ─────────────────────────────────────────────
//
// The pasteable text behind the Integrate page's three code tabs, kept out of
// the React component so a smoke can render and assert on it without a DOM.
//
// Every key this dashboard mints is PoP-bound — onboarding always puts
// `signing_pubkey` in the wallet-signed policy — so the bearer header ALONE is
// a 401. Each snippet therefore builds the request-body bytes first, hashes
// exactly those bytes, and signs the `murmur-rk-v2` canonical string defined in
// src/verdict/auth/runtime-key-pop.ts. That string is mirrored here field for
// field; changing it server-side means changing all three templates.
//
// Sealing: CoFHE ships a JS SDK, so only the TS tab seals end to end (it
// mirrors tools/agent-side-cofhe-sealer.ts, including the CoFHE 0.7 pair of
// setAccount + setConsumingContract). The PY and CURL tabs sign a correct
// request around handles that sealer produced, and say so.

export type SnippetLanguage = "typescript" | "python" | "curl";

/**
 * Substitute the `{{base}}` and `{{key}}` placeholders in a template.
 * When `runtimeKey` is undefined, swap `{{key}}` for the env-var pattern
 * idiomatic to each language (handled via the `keyBlock` arg per call).
 */
function renderSnippet(
  template: string,
  base: string,
  keyBlock: string,
): string {
  return template.replaceAll("{{base}}", base).replaceAll("{{key}}", keyBlock);
}

// ─── Templates ──────────────────────────────────────────────────────────────

const TS_TEMPLATE = `// Canonical private path. You seal locally and send handles; Murmur never
// holds your plaintext verdict. Node 20+, npm i @cofhe/sdk viem
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { Encryptable } from "@cofhe/sdk";
import { baseSepolia as cofheChain } from "@cofhe/sdk/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const API = "{{base}}";
const PATH = "/v2/gateway/calls";
{{key}}

// 1 · Both CoFHE bindings are Murmur's published addresses, never yours.
const meta = await fetch(API + "/v1/meta").then((r) => r.json());
const relayer = meta.fhenix?.relayer_address;
const consuming = meta.fhenix?.contract_address;
if (!relayer || !consuming) throw new Error("deployment publishes no CoFHE binding");

// 2 · Seal. Order is load-bearing (euint8 index, then euint16 confidence) and
//     CoFHE 0.7 needs setConsumingContract as well as setAccount. execute()
//     returns one element MORE than the inputs: the handles, then the single
//     batch signature that both handles carry.
const cofhe = createCofheClient(createCofheConfig({
  environment: "node",
  supportedChains: [cofheChain],
}));
await cofhe.connect(
  createPublicClient({ chain: baseSepolia, transport: http(process.env.FHENIX_RPC_URL) }),
  { account: { address: relayer } },
);
const [binaryHash, confidenceHash, batchProof] = await cofhe
  .encryptInputs([Encryptable.uint8(0n), Encryptable.uint16(7200n)])
  .setAccount(relayer)
  .setSecurityZone(0)
  .setConsumingContract(consuming)
  .execute();
const hex32 = (h) => "0x" + BigInt(h).toString(16).padStart(64, "0");
const proof = batchProof.startsWith("0x") ? batchProof : "0x" + batchProof;

// 3 · Freeze the body BYTES now. Re-serializing later changes the hash.
const body = Buffer.from(JSON.stringify({
  marketRef: { protocol: "polymarket-gamma", sourceId: "<condition-id>", configVersion: 1 },
  client_order_id: randomUUID(),
  client_nonce: "0x" + randomBytes(32).toString("hex"),
  privacy_mode: "sealed_fhenix",
  binary_index_input: { ct_hash: hex32(binaryHash), security_zone: 0, utype: 2, signature: proof },
  confidence_input: { ct_hash: hex32(confidenceHash), security_zone: 0, utype: 3, signature: proof },
  strategy_tag: "momentum",
}), "utf8");

// 4 · murmur-rk-v2 proof of possession. Dashboard-minted keys are PoP-bound,
//     so the bearer header on its own is a 401.
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomBytes(16).toString("hex");
const canonical = [
  "murmur-rk-v2",
  MURMUR_POP_AUDIENCE,
  MURMUR_RUNTIME_KEY_ID,
  timestamp,
  nonce,
  "POST",
  PATH,
  createHash("sha256").update(body).digest("hex"),
].join("\\n");
const popSignature = sign(null, Buffer.from(canonical, "utf8"), createPrivateKey({
  key: Buffer.from(MURMUR_RUNTIME_KEY_SIGNING_PK, "base64"),
  format: "der",
  type: "pkcs8",
})).toString("hex");

const res = await fetch(API + PATH, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Murmur-Runtime-Key": MURMUR_RUNTIME_KEY,
    "X-Murmur-Key-Timestamp": timestamp,
    "X-Murmur-Key-Nonce": nonce,
    "X-Murmur-Key-Signature": popSignature,
  },
  body,
});
const accepted = await res.json();
// 202 returns an attempt; poll GET /v2/gateway/attempts/<id> for the call_id.
console.log(accepted.attempt_id, accepted.status);`;

const PY_TEMPLATE = `# Signs a correct murmur-rk-v2 request. CoFHE ships a JS SDK only, so seal
# with the TS tab (or tools/agent-side-cofhe-sealer.ts) and pass its two
# handles plus the one shared batch proof in here.  pip install cryptography
import base64
import hashlib
import json
import os
import secrets
import time
import urllib.request
import uuid

from cryptography.hazmat.primitives.serialization import load_der_private_key

API = "{{base}}"
PATH = "/v2/gateway/calls"
{{key}}

signing_key = load_der_private_key(
    base64.b64decode(MURMUR_RUNTIME_KEY_SIGNING_PK), password=None
)

# One signature covers BOTH handles, in the order they were encrypted.
batch_proof = os.environ["MURMUR_BATCH_PROOF"]
body = json.dumps({
    "marketRef": {"protocol": "polymarket-gamma", "sourceId": "<condition-id>", "configVersion": 1},
    "client_order_id": str(uuid.uuid4()),
    "client_nonce": "0x" + secrets.token_hex(32),
    "privacy_mode": "sealed_fhenix",
    "binary_index_input": {
        "ct_hash": os.environ["MURMUR_BINARY_CT_HASH"],
        "security_zone": 0, "utype": 2, "signature": batch_proof,
    },
    "confidence_input": {
        "ct_hash": os.environ["MURMUR_CONFIDENCE_CT_HASH"],
        "security_zone": 0, "utype": 3, "signature": batch_proof,
    },
    "strategy_tag": "momentum",
}).encode()  # sign these exact bytes; re-dumping changes the hash

timestamp = str(int(time.time()))
nonce = secrets.token_hex(16)
canonical = "\\n".join([
    "murmur-rk-v2",
    MURMUR_POP_AUDIENCE,
    MURMUR_RUNTIME_KEY_ID,
    timestamp,
    nonce,
    "POST",
    PATH,
    hashlib.sha256(body).hexdigest(),
]).encode()

req = urllib.request.Request(API + PATH, method="POST", data=body, headers={
    "Content-Type": "application/json",
    "X-Murmur-Runtime-Key": MURMUR_RUNTIME_KEY,
    "X-Murmur-Key-Timestamp": timestamp,
    "X-Murmur-Key-Nonce": nonce,
    "X-Murmur-Key-Signature": signing_key.sign(canonical).hex(),
})
with urllib.request.urlopen(req) as resp:
    accepted = json.load(resp)
    # 202 returns an attempt; poll /v2/gateway/attempts/<id> for the call_id.
    print(accepted["attempt_id"], accepted["status"])`;

const CURL_TEMPLATE = `# Signs a correct murmur-rk-v2 request. Needs OpenSSL 3.x (raw Ed25519).
# CoFHE ships a JS SDK only: seal with the TS tab or
# tools/agent-side-cofhe-sealer.ts, then export the two handles and the one
# shared batch proof it prints.
{{key}}
BODY='{"marketRef":{"protocol":"polymarket-gamma","sourceId":"<condition-id>","configVersion":1},"client_order_id":"'"$(uuidgen)"'","client_nonce":"0x'"$(openssl rand -hex 32)"'","privacy_mode":"sealed_fhenix","binary_index_input":{"ct_hash":"'"$MURMUR_BINARY_CT_HASH"'","security_zone":0,"utype":2,"signature":"'"$MURMUR_BATCH_PROOF"'"},"confidence_input":{"ct_hash":"'"$MURMUR_CONFIDENCE_CT_HASH"'","security_zone":0,"utype":3,"signature":"'"$MURMUR_BATCH_PROOF"'"},"strategy_tag":"momentum"}'

# Hash the exact bytes that go on the wire, then sign the canonical string.
TS=$(date +%s)
NONCE=$(openssl rand -hex 16)
HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -r | cut -d' ' -f1)
KEYFILE=$(mktemp) && chmod 600 "$KEYFILE"
printf '%s' "$MURMUR_RUNTIME_KEY_SIGNING_PK" | base64 -d > "$KEYFILE"
# Ed25519 signs in one shot, so openssl needs a seekable -in file, not a pipe.
PAYLOAD=$(mktemp)
printf 'murmur-rk-v2\\n%s\\n%s\\n%s\\n%s\\nPOST\\n/v2/gateway/calls\\n%s' \\
  "$MURMUR_POP_AUDIENCE" "$MURMUR_RUNTIME_KEY_ID" "$TS" "$NONCE" "$HASH" > "$PAYLOAD"
SIG=$(openssl pkeyutl -sign -rawin -inkey "$KEYFILE" -keyform DER -in "$PAYLOAD" \\
  | xxd -p -c 256)
rm -f "$KEYFILE" "$PAYLOAD"

curl -X POST {{base}}/v2/gateway/calls \\
  -H "Content-Type: application/json" \\
  -H "X-Murmur-Runtime-Key: $MURMUR_RUNTIME_KEY" \\
  -H "X-Murmur-Key-Timestamp: $TS" \\
  -H "X-Murmur-Key-Nonce: $NONCE" \\
  -H "X-Murmur-Key-Signature: $SIG" \\
  -d "$BODY"`;

function pickTemplate(language: SnippetLanguage): string {
  if (language === "typescript") return TS_TEMPLATE;
  if (language === "python") return PY_TEMPLATE;
  return CURL_TEMPLATE;
}

/**
 * Build the language-idiomatic credential block. A PoP-bound key needs four
 * values, not one: the bearer, the key id and the signing key it was minted
 * with, and this deployment's PoP audience (which the daemon prints in
 * /v1/skill.md — it is configurable, so guessing the default here would sign
 * requests that verify nowhere).
 *
 * Only the bearer is ever inlined, and only on the one-time post-mint path;
 * everything else stays an env read so the snippet is safe to share.
 */
function buildKeyBlock(
  language: SnippetLanguage,
  runtimeKey: string | undefined,
): string {
  const literal = runtimeKey && runtimeKey.length > 0 ? runtimeKey : null;
  if (language === "typescript") {
    const bearer = literal
      ? `const MURMUR_RUNTIME_KEY = "${literal}"; // shown once — store in env before committing`
      : `const MURMUR_RUNTIME_KEY = process.env.MURMUR_RUNTIME_KEY ?? "";`;
    return [
      bearer,
      `const MURMUR_RUNTIME_KEY_ID = process.env.MURMUR_RUNTIME_KEY_ID ?? "";`,
      `const MURMUR_RUNTIME_KEY_SIGNING_PK = process.env.MURMUR_RUNTIME_KEY_SIGNING_PK ?? ""; // pkcs8 base64, shown once at mint`,
      `const MURMUR_POP_AUDIENCE = process.env.MURMUR_POP_AUDIENCE ?? ""; // this deployment's audience — see /v1/skill.md`,
    ].join("\n");
  }
  if (language === "python") {
    const bearer = literal
      ? `MURMUR_RUNTIME_KEY = "${literal}"  # shown once — store in env before committing`
      : `MURMUR_RUNTIME_KEY = os.environ["MURMUR_RUNTIME_KEY"]`;
    return [
      bearer,
      `MURMUR_RUNTIME_KEY_ID = os.environ["MURMUR_RUNTIME_KEY_ID"]`,
      `MURMUR_RUNTIME_KEY_SIGNING_PK = os.environ["MURMUR_RUNTIME_KEY_SIGNING_PK"]  # pkcs8 base64`,
      `MURMUR_POP_AUDIENCE = os.environ["MURMUR_POP_AUDIENCE"]  # see /v1/skill.md`,
    ].join("\n");
  }
  // curl
  const shellNote =
    `# Also export MURMUR_RUNTIME_KEY_ID, MURMUR_RUNTIME_KEY_SIGNING_PK (pkcs8\n` +
    `# base64) and MURMUR_POP_AUDIENCE — the audience is per deployment and is\n` +
    `# printed in /v1/skill.md.`;
  return literal
    ? `# Shown once — export now then remove this line before sharing.\nexport MURMUR_RUNTIME_KEY='${literal}'\n${shellNote}`
    : `# Set MURMUR_RUNTIME_KEY in your shell first.\n${shellNote}`;
}

/**
 * Render one language's snippet against a daemon base URL. `runtimeKey` is the
 * one-time post-mint secret; when omitted the bearer falls back to an env read
 * so the text is safe to share.
 */
export function renderGatewaySnippet(
  language: SnippetLanguage,
  base: string,
  runtimeKey?: string,
): string {
  return renderSnippet(
    pickTemplate(language),
    base,
    buildKeyBlock(language, runtimeKey),
  );
}
