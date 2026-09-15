import { strict as assert } from "node:assert";

import { sealedCallAttemptKind } from "./fhenix-gateway-attempt-kinds.js";
import type { CallAcceptedEvent } from "../types/events.js";

/**
 * Pins the wiring: the bus handed to the sealed-call attempt kind must reach the
 * acceptance call, or gateway submits never emit `call.accepted`.
 */
process.stdout.write("murmur gateway accept-event smoke\n");

const seen: CallAcceptedEvent[] = [];
const bus = { emit: (event: CallAcceptedEvent) => void seen.push(event) };

const kind = sealedCallAttemptKind({ events: bus });

assert.equal(typeof kind.accept, "function", "sealed kind exposes accept()");

// Structural guard: the accept closure must forward `events`.
const source = String(kind.accept);
assert.ok(
  /events\s*:/.test(source),
  "accept() must forward `events` to the acceptance call — dropping it is the bug this smoke exists for",
);

assert.equal(seen.length, 0, "constructing the kind must not emit anything");

process.stdout.write("OK gateway accept-event smoke\n");
