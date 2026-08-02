import { strict as assert } from "node:assert";

import { classifyRevealSource } from "./fhenix-reveal-attribution.js";

process.stdout.write("murmur fhenix reveal attribution smoke\n");

const daemon = "0xDaemon00000000000000000000000000000000A1";
const controller = "0xC0ntr0110000000000000000000000000000B2";

// Publish tx from the murmur fallback EOA → daemon_fallback (case-insensitive).
assert.equal(
  classifyRevealSource(daemon.toLowerCase(), {
    daemonRevealSender: daemon,
    controllerWallet: controller,
  }),
  "daemon_fallback",
);

// Publish tx from the agent's registered controller wallet → agent.
assert.equal(
  classifyRevealSource(controller.toUpperCase(), {
    daemonRevealSender: daemon,
    controllerWallet: controller,
  }),
  "agent",
);

// Any other sender → unattributed_external.
assert.equal(
  classifyRevealSource("0x9999999999999999999999999999999999999999", {
    daemonRevealSender: daemon,
    controllerWallet: controller,
  }),
  "unattributed_external",
);

// No daemon configured: a controller-wallet match is still the agent.
assert.equal(
  classifyRevealSource(controller, { controllerWallet: controller }),
  "agent",
);

// Null/absent sender cannot be attributed → external.
assert.equal(
  classifyRevealSource(null, { daemonRevealSender: daemon, controllerWallet: controller }),
  "unattributed_external",
);

// daemon_fallback takes precedence even if it somehow equalled the controller
// (defensive ordering); they are disjoint in practice.
assert.equal(
  classifyRevealSource(daemon, { daemonRevealSender: daemon, controllerWallet: daemon }),
  "daemon_fallback",
);

process.stdout.write("fhenix reveal attribution smoke ok\n");
