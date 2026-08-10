import { strict as assert } from "node:assert";

import { buildAgentOperatePrompt } from "./public-skill-markdown.js";

process.stdout.write("public agent skill smoke\n");

const prompt = buildAgentOperatePrompt("https://api.example", "alpha-bot");

assert.ok(prompt.includes("alpha-bot"), "prompt should embed the agent slug");
assert.ok(
  prompt.includes("__MURMUR_RUNTIME_KEY__"),
  "prompt should carry the runtime key sentinel",
);
assert.ok(
  prompt.includes("/v2/gateway/calls/seal"),
  "prompt should reference the seal endpoint",
);
assert.ok(
  prompt.includes("https://api.example"),
  "prompt should embed the api base",
);
assert.ok(
  prompt.includes("murmur_sealed_fhenix"),
  "prompt should declare the sealed fhenix privacy mode",
);

process.stdout.write("  ok agent operate prompt is personalized and sealed\n");
