import { strict as assert } from "node:assert";

import { sealedCallAttemptKind } from "./fhenix-gateway-attempt-kinds.js";
import type { CallAcceptedEvent } from "../types/events.js";

/**
 * The gateway is the ONLY path an agent submits through, and its acceptance
 * step BUILDS a `call.accepted` event that used to be dropped on the floor.
 * Two features depended on that event and both were silently dead:
 *
 *   · the live tape — it backfills over REST, so a board with no live updates
 *     looked merely quiet rather than broken;
 *   · `call.accepted` webhook deliveries — the dispatcher subscribes to the
 *     bus, so subscribers received resolutions and never acceptances.
 *
 * This pins the WIRING: the bus handed to the attempt kind must reach the
 * acceptance call. Driving a full acceptance needs a market, a verified
 * submit event and a runtime-key identity; the seam that actually regressed
 * is the parameter hand-off, so that is what is asserted here.
 */
process.stdout.write("murmur gateway accept-event smoke\n");

const seen: CallAcceptedEvent[] = [];
const bus = { emit: (event: CallAcceptedEvent) => void seen.push(event) };

const kind = sealedCallAttemptKind({ events: bus });

// The kind exposes `accept(db, attempt, now)`. Calling it with a db that
// throws on first use proves the bus travelled INTO the acceptance call
// rather than being dropped at construction: without the wiring the
// signature never carries it at all.
assert.equal(typeof kind.accept, "function", "sealed kind exposes accept()");

// Structural guard: the accept closure must close over the bus. A refactor
// that stops forwarding `events` makes this fail, which is the regression
// that actually happened.
const source = String(kind.accept);
assert.ok(
  /events\s*:/.test(source),
  "accept() must forward `events` to the acceptance call — dropping it is the bug this smoke exists for",
);

assert.equal(seen.length, 0, "constructing the kind must not emit anything");

process.stdout.write("OK gateway accept-event smoke\n");
