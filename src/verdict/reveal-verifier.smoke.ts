import { strict as assert } from "node:assert";

import { decideReveal, WATCHER_STALE_MS } from "./reveal-verifier.js";

// A stalled watcher must never turn a delivered call into a refund. "Pending"
// is an answer only once the reveal ingestor has looked past the horizon and
// is still alive; otherwise it is "unobserved", which settles nothing.
process.stdout.write("murmur reveal verifier smoke\n");

const HORIZON = "2026-09-13T12:00:00.000Z";
const NOW = Date.parse("2026-09-13T13:00:00.000Z");
const pending = { reveal_status: "pending", revealed_at: null, reveal_open_at: HORIZON };
const iso = (ms: number) => new Date(ms).toISOString();

assert.equal(decideReveal(null, iso(NOW), NOW), null, "an unknown call settles nothing");
assert.equal(
  decideReveal({ ...pending, reveal_status: "revealed", revealed_at: iso(NOW - 60_000) }, null, NOW),
  true,
  "a revealed row is a reveal regardless of the cursor",
);
assert.equal(decideReveal({ ...pending, reveal_status: "invalid" }, iso(NOW), NOW), false);
assert.equal(decideReveal({ ...pending, reveal_status: "missed" }, iso(NOW), NOW), false);

// The four pending cases.
assert.equal(decideReveal(pending, null, NOW), null, "watcher never ran");
assert.equal(
  decideReveal(pending, iso(Date.parse(HORIZON) - 1), NOW),
  null,
  "watcher has not looked since the horizon opened",
);
assert.equal(
  decideReveal(pending, iso(NOW - WATCHER_STALE_MS - 1), NOW),
  null,
  "watcher stopped advancing: this is the daemon-died-on-drpc case",
);
assert.equal(
  decideReveal(pending, iso(NOW - 60_000), NOW),
  false,
  "watcher scanned past the horizon a minute ago and found nothing: genuinely unrevealed",
);

process.stdout.write("OK reveal verifier smoke\n");
