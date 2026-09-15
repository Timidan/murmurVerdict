import { strict as assert } from "node:assert";

import { tapeRows } from "./live-tape.js";

process.stdout.write("murmur live tape smoke\n");

const NOW = Date.parse("2026-09-13T12:00:00Z");
const h = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const sealed = (id: string, hoursAgo: number) => ({ type: "call.accepted", call_id: id, accepted_at: h(hoursAgo) });
const resolved = (id: string, hoursAgo: number) => ({ type: "call.resolved", call_id: id, resolved_at: h(hoursAgo) });

// One row per call: the same call sealed and then resolved is ONE row, and
// the row is the resolved one.
{
  const out = tapeRows([resolved("a", 2), sealed("a", 4), sealed("b", 5)], NOW, 50);
  assert.deepEqual(out.rows.map((r) => r.call_id + ":" + r.type), ["a:call.resolved", "b:call.accepted"]);
  assert.equal(out.older, 0);
}

// Resolved supersedes sealed even if the sealed event is listed first.
{
  const out = tapeRows([sealed("a", 4), resolved("a", 2)], NOW, 50);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].type, "call.resolved");
}

// The window: 7-week-old rows are counted, not shown.
{
  const out = tapeRows([resolved("new", 1), resolved("old1", 24 * 14), sealed("old2", 24 * 49)], NOW, 50);
  assert.deepEqual(out.rows.map((r) => r.call_id), ["new"]);
  assert.equal(out.older, 2, "what fell outside the window is reported");
}

// The count is only a ceiling INSIDE the window, and the cut is reported too.
{
  const events = Array.from({ length: 6 }, (_, i) => resolved(`c${i}`, i));
  const out = tapeRows(events, NOW, 4);
  assert.equal(out.rows.length, 4);
  assert.equal(out.overflow, 2);
  assert.equal(out.older, 0);
}

// An unparsable timestamp is treated as ancient, never as "now".
{
  const out = tapeRows([{ type: "call.accepted", call_id: "x", accepted_at: "garbage" }], NOW, 50);
  assert.equal(out.rows.length, 0);
  assert.equal(out.older, 1);
}

process.stdout.write("OK live tape smoke\n");
