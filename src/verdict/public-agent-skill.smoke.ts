import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { injectRuntimeCredentials } from "../types/runtime-credentials.js";
import {
  POP_HEADER_NONCE,
  POP_HEADER_SIGNATURE,
  POP_HEADER_TIMESTAMP,
  verifyRuntimeKeyPop,
} from "./auth/runtime-key-pop.js";
import { openDb } from "./db.js";
import { buildAgentOperatePrompt, buildSkillMarkdown } from "./public-skill-markdown.js";

process.stdout.write("public agent skill smoke\n");

const audience = "murmur-prompt-smoke";
const runtimeKey = "mrt_prompt_smoke_secret";
const runtimeKeyId = "rk_prompt_smoke";
const pair = await webcrypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
) as webcrypto.CryptoKeyPair;
const signingPubkeyHex = Buffer.from(
  await webcrypto.subtle.exportKey("raw", pair.publicKey),
).toString("hex");
const signingPrivateKey = Buffer.from(
  await webcrypto.subtle.exportKey("pkcs8", pair.privateKey),
).toString("base64");

const template = buildAgentOperatePrompt(
  "https://api.example",
  "alpha-bot",
  audience,
  true,
);
const prompt = injectRuntimeCredentials(template, {
  runtimeKey,
  runtimeKeyId,
  signingPrivateKey,
});

assert.ok(prompt.includes("alpha-bot"), "prompt should embed the agent slug");
assert.ok(prompt.includes(runtimeKey), "rendered prompt should carry the bearer secret");
assert.ok(prompt.includes(runtimeKeyId), "rendered prompt should carry the runtime key id");
assert.ok(prompt.includes(signingPrivateKey), "rendered prompt should carry the signing private key");
assert.ok(!prompt.includes("__MURMUR_"), "rendered prompt should leave no credential sentinel");
assert.ok(prompt.includes(audience), "prompt should embed the deployment PoP audience");
assert.ok(
  prompt.includes("operator can read your verdict before public reveal"),
  "prompt should state the owned-sealing privacy trade-off up front",
);
assert.ok(prompt.includes("/v2/gateway/calls/seal"), "prompt should use owned sealing");
assert.ok(!prompt.includes('privacy_mode": "sealed_fhenix"'), "prompt should not offer client sealing");
assert.ok(!prompt.includes("/v1/skill.md"), "prompt should not defer to another document");
assert.ok(!prompt.includes('import "dotenv/config"'), "runner should not depend on Murmur's install");
assert.ok(!prompt.includes("--env-file"), "runner should not require Node 20.6");

const integratorSkill = buildSkillMarkdown("https://api.example", audience);
assert.ok(
  integratorSkill.includes('POST "https://api.example/v2/gateway/calls"') &&
    integratorSkill.includes('"binary_index_input"') &&
    integratorSkill.includes('"privacy_mode": "sealed_fhenix"'),
  "public integrator skill should retain the client-sealed path",
);

// CoFHE 0.7 verifies the pair against BOTH bindings. A snippet carrying only
// .setAccount() throws "Consuming contract is not set" in the agent's own
// process, so the published skill must document both or it ships a dead end.
assert.ok(
  integratorSkill.includes(".setAccount(relayerAddress)"),
  "client-sealing snippet must bind the CoFHE account to the published relayer",
);
assert.ok(
  integratorSkill.includes(".setConsumingContract(contractAddress)"),
  "client-sealing snippet must bind the CoFHE consuming contract; 0.7 throws without it",
);
assert.ok(
  integratorSkill.includes("fhenix.relayer_address") &&
    integratorSkill.includes("fhenix.contract_address"),
  "client-sealing doc must read BOTH bindings from /v1/meta",
);
assert.ok(
  integratorSkill.includes("client-side proof binding is unavailable"),
  "client-sealing snippet must stop when either binding is null",
);
assert.ok(
  /returns one element MORE than the inputs/.test(integratorSkill) &&
    integratorSkill.includes("const [binaryHash, confidenceHash, batchSignature]"),
  "client-sealing doc must show the batch result shape: handles then the shared signature",
);

const disabled = buildAgentOperatePrompt(
  "https://api.example",
  "alpha-bot",
  audience,
  false,
);
assert.ok(
  disabled.indexOf("MURMUR_OWNED_SEALING_ENABLED=false") < disabled.indexOf("## Credentials"),
  "disabled prompt should lead with the deployment limitation",
);
assert.ok(disabled.includes("ask your owner"), "disabled prompt should give the only recovery path");
assert.ok(!disabled.includes("```js"), "disabled prompt should not hand out a doomed call");

const incomplete = injectRuntimeCredentials(template, { runtimeKey });
assert.ok(incomplete.includes("STOP"), "an incomplete minted credential should fail closed");
assert.ok(!incomplete.includes("```js"), "an incomplete credential should not expose runnable code");

const envBlock = prompt.match(/```dotenv\n([\s\S]*?)\n```/)?.[1];
const nodeScript = prompt.match(/```js\n([\s\S]*?)\n```/)?.[1];
assert.ok(envBlock, "prompt should contain one dotenv credential block");
assert.ok(nodeScript, "prompt should contain one executable Node runner");

const db = openDb({ path: ":memory:" });
const workspaceTmp = mkdtempSync(join(tmpdir(), "murmur-agent-prompt-"));
const submittedBodies: Buffer[] = [];
let verifiedRequests = 0;
let terminalSubmission = false;

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);
  const pathAndQuery = req.url ?? "/";

  try {
    if (req.method === "GET" && pathAndQuery === "/v1/markets?status=listed") {
      const now = Date.now();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        markets: [{
          market_id: "0x" + "ab".repeat(32),
          adapter_id: "polymarket-gamma",
          market_kind: "event_binary",
          market_config_version: 7,
          status: "listed",
          config_json: JSON.stringify({ question: "Will the prompt smoke pass?" }),
          clock: {
            submission_open_at_ms: now - 1_000,
            submission_close_at_ms: now + 60_000,
          },
        }],
      }));
      return;
    }

    assert.equal(req.headers["x-murmur-runtime-key"], runtimeKey);
    verifyRuntimeKeyPop(db, {
      runtimeKeyId,
      signingPubkeyHex,
      audience,
      now: new Date(),
      request: {
        method: req.method ?? "GET",
        pathAndQuery,
        rawBodySha256: createHash("sha256").update(rawBody).digest("hex"),
        timestampHeader: req.headers[POP_HEADER_TIMESTAMP.toLowerCase()] as string | undefined,
        nonceHeader: req.headers[POP_HEADER_NONCE.toLowerCase()] as string | undefined,
        signatureHeader: req.headers[POP_HEADER_SIGNATURE.toLowerCase()] as string | undefined,
      },
    });
    verifiedRequests++;

    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && pathAndQuery === "/v2/gateway/calls/seal") {
      submittedBodies.push(rawBody);
      res.statusCode = 202;
      res.end(JSON.stringify(terminalSubmission
        ? { attempt_id: "attempt-prompt-fail", status: "failed_terminal", error: "smoke failure" }
        : { attempt_id: "attempt-prompt-smoke", status: "submitted" }));
      return;
    }
    if (req.method === "GET" && pathAndQuery === "/v2/gateway/attempts/attempt-prompt-smoke") {
      res.end(JSON.stringify({
        attempt_id: "attempt-prompt-smoke",
        status: "accepted",
        call_id: "call-prompt-smoke",
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

async function run(): Promise<void> {
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const localEnv = envBlock!.replace(
      "MURMUR_API=https://api.example",
      `MURMUR_API=http://127.0.0.1:${address.port}`,
    );
    writeFileSync(join(workspaceTmp, ".env"), `${localEnv}\n`, { mode: 0o600 });
    writeFileSync(join(workspaceTmp, "submit.mjs"), `${nodeScript}\n`);

    const child = spawn(process.execPath, ["submit.mjs"], {
      cwd: workspaceTmp,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.equal(code, 0, stderr || stdout);
    assert.match(stdout, /call-prompt-smoke/);
    assert.equal(verifiedRequests, 2, "submit and attempt read should both pass PoP verification");
    assert.equal(submittedBodies.length, 1);
    const submitted = JSON.parse(submittedBodies[0]!.toString("utf8")) as {
      marketRef: { protocol: string; sourceId: string; configVersion: number };
      client_nonce: string;
    };
    assert.deepEqual(submitted.marketRef, {
      protocol: "polymarket-gamma",
      sourceId: "0x" + "ab".repeat(32),
      configVersion: 7,
    });
    assert.match(submitted.client_nonce, /^0x[0-9a-f]{64}$/);

    terminalSubmission = true;
    const failedChild = spawn(process.execPath, ["submit.mjs"], {
      cwd: workspaceTmp,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failedOutput = "";
    failedChild.stdout.on("data", (chunk) => { failedOutput += String(chunk); });
    failedChild.stderr.on("data", (chunk) => { failedOutput += String(chunk); });
    const failedCode = await new Promise<number | null>((resolve) =>
      failedChild.once("close", resolve));
    assert.notEqual(failedCode, 0, "terminal submission should fail the runner");
    assert.match(failedOutput, /Submission failed:.*failed_terminal/s);
    assert.equal(verifiedRequests, 3, "terminal submit should also pass PoP verification");
    process.stdout.write("  ok rendered prompt signs submit + observe exactly as the verifier requires\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(workspaceTmp, { recursive: true, force: true });
  }
}

await run();
