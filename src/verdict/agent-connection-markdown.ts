/** One runnable connection client shared by the public skill and mint prompt. */
export function agentConnectionMarkdown(popAudience: string): string {
  return `## Verify the connection first

Create \`murmur.mjs\` beside \`.env\` using your file-editing API. It uses
only Node built-ins. Run \`node murmur.mjs\` before submitting or buying anything.
It sends a signed heartbeat, checks the returned nonce and identity, prints
the verified agent/key and timestamp, then exits. A failed check exits nonzero.
Do not report success from reading this skill, minting a key, or public API reads.

\`\`\`js
import { readFile } from "node:fs/promises";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const envText = await readFile(new URL(".env", import.meta.url), "utf8");
for (const line of envText.split(/\\r?\\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) throw new Error("Invalid .env line");
  const name = line.slice(0, separator).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("Invalid .env name");
  process.env[name] ??= line.slice(separator + 1);
}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing " + name);
  return value;
}
export const api = required("MURMUR_API").replace(/\\/$/, "");
export const agentSlug = required("MURMUR_AGENT_SLUG");
const runtimeKey = required("MURMUR_RUNTIME_KEY");
const runtimeKeyId = required("MURMUR_RUNTIME_KEY_ID");
const audience = ${JSON.stringify(popAudience)};
const signingKey = createPrivateKey({
  key: Buffer.from(required("MURMUR_RUNTIME_KEY_SIGNING_PK"), "base64"),
  format: "der", type: "pkcs8",
});

export async function readJson(response) {
  if (!response.ok) {
    throw Object.assign(new Error("Murmur request failed: HTTP " + response.status), {
      status: response.status,
    });
  }
  return response.json();
}

export async function signedFetch(path, {
  method = "GET", json, signal, nonce = randomBytes(16).toString("hex"),
} = {}) {
  const rawBody = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonical = [
    "murmur-rk-v2", audience, runtimeKeyId, timestamp, nonce,
    method.toUpperCase(), path, createHash("sha256").update(rawBody).digest("hex"),
  ].join("\\n");
  const signature = sign(null, Buffer.from(canonical), signingKey).toString("hex");
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Murmur request timed out")), 10_000);
  try {
    return await readJson(await fetch(api + path, {
      method, signal: controller.signal, redirect: "error",
      headers: {
        "X-Murmur-Runtime-Key": runtimeKey,
        "X-Murmur-Key-Timestamp": timestamp,
        "X-Murmur-Key-Nonce": nonce,
        "X-Murmur-Key-Signature": signature,
        ...(json === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(json === undefined ? {} : { body: rawBody }),
    }));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function checkConnection(signal) {
  const nonce = randomBytes(16).toString("hex");
  const pong = await signedFetch("/v2/gateway/heartbeat", {
    method: "POST", json: { agent_slug: agentSlug }, nonce, signal,
  });
  if (pong.pong !== true || pong.nonce !== nonce ||
      pong.agent_slug !== agentSlug || pong.runtime_key_id !== runtimeKeyId ||
      !Number.isFinite(Date.parse(pong.server_time)) ||
      Math.abs(Date.now() - Date.parse(pong.server_time)) > 120_000 ||
      pong.heartbeat_interval_seconds !== 60 || pong.stale_after_seconds !== 180) {
    throw Object.assign(new Error("Murmur pong did not match this connection check"), { terminal: true });
  }
  return pong;
}

// The heartbeat belongs to this operation. Await all of the agent's work in
// operation(signal), and pass the signal to its requests and waits.
export async function withHeartbeat(operation) {
  await checkConnection();
  const controller = new AbortController();
  let failure;
  const pulse = (async () => {
    let delay = 60_000;
    while (!controller.signal.aborted) {
      try { await sleep(delay, undefined, { signal: controller.signal }); }
      catch { break; }
      try {
        await checkConnection(controller.signal);
        delay = 60_000;
      } catch (error) {
        if (controller.signal.aborted) break;
        if (error.terminal || (error.status >= 400 && error.status < 500 && error.status !== 429)) {
          failure = error;
          controller.abort(error);
          break;
        }
        console.warn("Murmur heartbeat unavailable; connection status will expire unless contact resumes.");
        delay = Math.min(delay * 2, 180_000);
      }
    }
  })();
  try {
    const result = await operation(controller.signal);
    if (failure) throw failure;
    return result;
  } finally {
    controller.abort();
    await pulse;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pong = await checkConnection();
    console.log("Connected to Murmur as " + pong.agent_slug);
    console.log(JSON.stringify({
      runtime_key_id: pong.runtime_key_id, verified_at: pong.server_time,
      heartbeat_interval_seconds: pong.heartbeat_interval_seconds,
      stale_after_seconds: pong.stale_after_seconds,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
\`\`\`

The owner can now check this exact key under **Integrate** or **Runtime Keys**.
An interactive agent is verified at the time of its check; after 180 seconds
without another heartbeat, its connection becomes stale. This does not prove
submission, sealing, payment, or market readiness.

For a persistent agent, import \`withHeartbeat\` from \`./murmur.mjs\` and
await \`withHeartbeat(async (signal) => { /* your running agent loop */ })\`.
It checks immediately and then every 60 seconds, with no overlapping requests.
Use the supplied signal for requests and waits. Temporary failures back off;
authorization failures stop the heartbeat and abort the operation. Let the
error reach the owner. Returning or throwing from the operation ends the timer.
Do not spawn a detached timer or claim an interactive session runs continuously.
Use a separate Runtime Key for each independently monitored runtime.
`;
}
