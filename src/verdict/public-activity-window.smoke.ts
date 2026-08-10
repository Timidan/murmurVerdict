import { strict as assert } from "node:assert";

import { publicActivityWindow } from "./public-activity-window.js";

const window = publicActivityWindow(new Date("2026-06-12T09:30:00Z"));
assert.deepEqual(window, {
  served_at: "2026-06-12T09:30:00Z",
  since_iso: "2026-06-11T09:30:00Z",
});

process.stdout.write("public activity window smoke ok\n");
