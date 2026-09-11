// ─── The Integrate page's snippets must actually authenticate ───────────────
//
// The panel calls these three snippets the canonical gateway path, and every
// key this dashboard mints is PoP-bound, so a snippet that sends only
// `X-Murmur-Runtime-Key` hands the reader a guaranteed 401. That is what
// shipped until 2026-08-23.
//
// Two layers of guard:
//   1. Structural, always on — every language sends all four auth headers and
//      signs the murmur-rk-v2 fields in the server's order, taken from
//      src/verdict/auth/runtime-key-pop.ts rather than restated here.
//   2. Executable, when the toolchain is present — the PY and CURL snippets
//      are RUN verbatim against a server that calls the real
//      verifyRuntimeKeyPop. This is what caught `openssl pkeyutl -rawin`
//      refusing a pipe ("unable to determine file size for oneshot
//      operation"): the snippet read fine and did not work.
//
// The TS tab cannot be executed here — it seals through @cofhe/sdk against a
// live relayer — so it is covered structurally, including the CoFHE 0.7 pair
// of bindings that tools/agent-side-cofhe-sealer.ts uses.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";

import {
  POP_HEADER_NONCE,
  POP_HEADER_SIGNATURE,
  POP_HEADER_TIMESTAMP,
  RUNTIME_KEY_POP_VERSION,
  buildRuntimeKeyPopSigningString,
  verifyRuntimeKeyPop,
} from "../../../../../src/verdict/auth/runtime-key-pop.js";
import { openDb } from "../../../../../src/verdict/db.js";
import {
  renderGatewaySnippet,
  type SnippetLanguage,
} from "./gateway-snippets.js";

process.stdout.write("gateway snippet smoke\n");

const LANGUAGES: SnippetLanguage[] = ["typescript", "python", "curl"];
const GATEWAY_PATH = "/v2/gateway/calls";

// ─── 1. Structural ──────────────────────────────────────────────────────────

/** The signed field order, read off the server's own builder. */
const canonicalFields = buildRuntimeKeyPopSigningString({
  audience: "AUDIENCE",
  runtimeKeyId: "KEY_ID",
  timestamp: 1,
  nonce: "NONCE",
  method: "POST",
  pathAndQuery: GATEWAY_PATH,
  rawBodySha256: "BODY_HASH",
}).split("\n");
assert.equal(canonicalFields.length, 8);
assert.equal(canonicalFields[0], RUNTIME_KEY_POP_VERSION);

/**
 * Which canonical positions are runtime values rather than literals. Used to
 * rebuild the bash printf format the CURL tab has to carry, so a server-side
 * reordering fails here instead of at the reader's terminal.
 */
const SUBSTITUTED_POSITIONS = new Set([1, 2, 3, 4, 7]);
const CURL_PRINTF_FORMAT = canonicalFields
  .map((field, index) => (SUBSTITUTED_POSITIONS.has(index) ? "%s" : field))
  .join("\\n");
const CURL_PRINTF_ARGUMENTS =
  `"$MURMUR_POP_AUDIENCE" "$MURMUR_RUNTIME_KEY_ID" "$TS" "$NONCE" "$HASH"`;

/**
 * Where each canonical field is named, in source order, for the languages that
 * build the string left to right. bash uses printf, so it is checked above.
 */
const FIELD_TOKENS: Partial<Record<SnippetLanguage, string[]>> = {
  typescript: [
    `"${RUNTIME_KEY_POP_VERSION}"`,
    "MURMUR_POP_AUDIENCE,",
    "MURMUR_RUNTIME_KEY_ID,",
    "timestamp,",
    "nonce,",
    `"POST",`,
    "PATH,",
    `createHash("sha256").update(body).digest("hex")`,
  ],
  python: [
    `"${RUNTIME_KEY_POP_VERSION}"`,
    "MURMUR_POP_AUDIENCE,",
    "MURMUR_RUNTIME_KEY_ID,",
    "timestamp,",
    "nonce,",
    `"POST",`,
    "PATH,",
    "hashlib.sha256(body).hexdigest()",
  ],
};

for (const language of LANGUAGES) {
  const snippet = renderGatewaySnippet(language, "https://api.example");

  for (const header of [
    "X-Murmur-Runtime-Key",
    POP_HEADER_TIMESTAMP,
    POP_HEADER_NONCE,
    POP_HEADER_SIGNATURE,
  ]) {
    assert.ok(
      snippet.includes(header),
      `${language} snippet must send ${header}; the bearer alone is a 401`,
    );
  }

  // The canonical string is signed in the server's field order, and the body
  // hash is taken over bytes that already exist — a snippet that re-serializes
  // after signing hashes something the server never receives.
  let cursor = -1;
  for (const [index, token] of (FIELD_TOKENS[language] ?? []).entries()) {
    const at = snippet.indexOf(token, cursor + 1);
    assert.ok(
      at > cursor,
      `${language} snippet must sign ${canonicalFields[index]!} in position ${index} (looking for ${token})`,
    );
    cursor = at;
  }

  assert.ok(
    !snippet.includes("createCofheVerdictInputs") &&
      !snippet.includes("create_cofhe_verdict_inputs"),
    `${language} snippet must not call a helper that does not exist`,
  );
}

const curlSnippet = renderGatewaySnippet("curl", "https://api.example");
assert.ok(
  curlSnippet.includes(`printf '${CURL_PRINTF_FORMAT}'`),
  `curl snippet must printf the canonical format ${CURL_PRINTF_FORMAT}`,
);
assert.ok(
  curlSnippet.indexOf(CURL_PRINTF_ARGUMENTS) >
    curlSnippet.indexOf(`printf '${CURL_PRINTF_FORMAT}'`),
  "curl snippet must feed the substituted fields in canonical order",
);

// CoFHE 0.7 verifies the pair against BOTH bindings; setAccount alone throws
// "Consuming contract is not set" before any request is made.
const tsSnippet = renderGatewaySnippet("typescript", "https://api.example");
assert.ok(
  tsSnippet.includes(".setAccount(relayer)") &&
    tsSnippet.includes(".setConsumingContract(consuming)"),
  "TS snippet must set both CoFHE 0.7 bindings",
);
assert.ok(
  tsSnippet.includes("relayer_address") && tsSnippet.includes("contract_address"),
  "TS snippet must read both bindings from /v1/meta",
);
assert.ok(
  tsSnippet.includes("const [binaryHash, confidenceHash, batchProof]"),
  "TS snippet must destructure the handles and the trailing shared batch proof",
);

// The chain comes from the same /v1/meta block as the bindings — a snippet
// that pins Base Sepolia signs for a chain the deployment may not run.
assert.ok(
  tsSnippet.includes("meta.fhenix?.chain_id_numeric") &&
    !tsSnippet.includes("baseSepolia"),
  "TS snippet must select the chain from /v1/meta, not hardcode one",
);

// No sample market, outcome, confidence or strategy in pasteable text.
for (const language of LANGUAGES) {
  const snippet = renderGatewaySnippet(language, "https://api.example");
  for (const sample of ["<condition-id>", "momentum", "7200"]) {
    assert.ok(
      !snippet.includes(sample),
      `${language} snippet must not ship the sample value ${sample}`,
    );
  }
  assert.ok(
    snippet.includes("MURMUR_MARKET_SOURCE_ID"),
    `${language} snippet must require the market reference as an input`,
  );
}

// The one-time post-mint path inlines only the bearer.
const withKey = renderGatewaySnippet("typescript", "https://api.example", "mrt_secret");
assert.ok(withKey.includes(`"mrt_secret"`), "post-mint render should inline the bearer");
assert.ok(
  withKey.includes("process.env.MURMUR_RUNTIME_KEY_SIGNING_PK"),
  "the signing key stays an env read even post-mint",
);

// ─── 2. Executable ──────────────────────────────────────────────────────────

function have(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

const canRunBash = have("bash", ["-c", "command -v openssl xxd uuidgen base64 >/dev/null"]);
const canRunPython = have("python3", [
  "-c",
  "import cryptography.hazmat.primitives.serialization",
]);

if (!canRunBash) {
  process.stdout.write("  ~ skipping CURL execution: needs bash, openssl, xxd, uuidgen\n");
}
if (!canRunPython) {
  process.stdout.write("  ~ skipping PY execution: needs python3 with `cryptography`\n");
}

if (canRunBash || canRunPython) {
  const audience = "murmur-snippet-smoke";
  const runtimeKey = "mrt_snippet_smoke";
  const runtimeKeyId = "rk_snippet_smoke";
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const signingPubkeyHex = Buffer.from(
    await webcrypto.subtle.exportKey("raw", pair.publicKey),
  ).toString("hex");
  const signingPrivateKey = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64");

  const db = openDb({ path: ":memory:" });
  const accepted: string[] = [];
  const rejected: string[] = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);
    res.setHeader("Content-Type", "application/json");
    try {
      assert.equal(req.headers["x-murmur-runtime-key"], runtimeKey);
      verifyRuntimeKeyPop(db, {
        runtimeKeyId,
        signingPubkeyHex,
        audience,
        now: new Date(),
        request: {
          method: req.method ?? "GET",
          pathAndQuery: req.url ?? "/",
          rawBodySha256: createHash("sha256").update(rawBody).digest("hex"),
          timestampHeader: req.headers[POP_HEADER_TIMESTAMP.toLowerCase()] as string,
          nonceHeader: req.headers[POP_HEADER_NONCE.toLowerCase()] as string,
          signatureHeader: req.headers[POP_HEADER_SIGNATURE.toLowerCase()] as string,
        },
      });
      // The snippet also has to send a body the gateway schema can read.
      JSON.parse(rawBody.toString("utf8"));
      accepted.push(req.url ?? "/");
      res.statusCode = 202;
      res.end(JSON.stringify({ attempt_id: "attempt-snippet", status: "submitted" }));
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : String(error));
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "runtime_key_signature_invalid" }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  // Handle fixtures stand in for a real CoFHE seal: PoP covers the body bytes,
  // so their contents are irrelevant to what this smoke proves.
  const env = {
    ...process.env,
    MURMUR_RUNTIME_KEY: runtimeKey,
    MURMUR_RUNTIME_KEY_ID: runtimeKeyId,
    MURMUR_RUNTIME_KEY_SIGNING_PK: signingPrivateKey,
    MURMUR_POP_AUDIENCE: audience,
    MURMUR_BATCH_PROOF: `0x${"ab".repeat(64)}`,
    MURMUR_BINARY_CT_HASH: `0x${"11".repeat(32)}`,
    MURMUR_CONFIDENCE_CT_HASH: `0x${"22".repeat(32)}`,
    // The market reference is a required input now; unset is a hard stop.
    MURMUR_MARKET_PROTOCOL: "polymarket-gamma",
    MURMUR_MARKET_SOURCE_ID: "0x" + "cd".repeat(32),
    MURMUR_MARKET_CONFIG_VERSION: "1",
  };

  async function runSnippet(command: string, args: string[]): Promise<string> {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.equal(code, 0, `${command} exited ${code}: ${stderr || stdout}`);
    return `${stdout}${stderr}`;
  }

  let expected = 0;
  try {
    if (canRunBash) {
      const bash = renderGatewaySnippet("curl", base)
        .replace("curl -X POST", "curl -sS --fail-with-body -X POST");
      const out = await runSnippet("bash", ["-c", bash]);
      assert.match(out, /attempt-snippet/, `CURL snippet did not authenticate: ${out}`);
      expected += 1;
    }
    if (canRunPython) {
      const out = await runSnippet("python3", ["-c", renderGatewaySnippet("python", base)]);
      assert.match(out, /attempt-snippet/, `PY snippet did not authenticate: ${out}`);
      expected += 1;
    }
  } finally {
    server.close();
  }

  assert.deepEqual(
    rejected,
    [],
    `a rendered snippet was rejected by the real PoP verifier: ${rejected.join(" | ")}`,
  );
  assert.equal(accepted.length, expected, "every executed snippet must reach the gateway path");
  assert.ok(
    accepted.every((path) => path === GATEWAY_PATH),
    "snippets must sign the same path they POST to",
  );
  process.stdout.write(`  · ${expected} snippet(s) executed and verified end to end\n`);
}

process.stdout.write("gateway snippet smoke ok\n");
