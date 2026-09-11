import assert from "node:assert/strict";

import {
  formatLocalDateTime,
  formatLocalDateTimeShort,
  formatLocalDayLabel,
  localDayKey,
} from "./date-time-format.js";

// ─── local calendar days ─────────────────────────────────────────────────────
//
// The call history groups by day, and the day it groups by has to be the
// READER's. Slicing the first ten characters off an ISO stamp groups by UTC,
// which files a 7pm call in New York under tomorrow. These assertions pin the
// local behaviour without pinning the runner to one timezone.

// Constructed with the local-time Date constructor: half past midnight ON the
// twentieth, wherever this runs. In every zone east of UTC that same instant is
// still the nineteenth in UTC, so a UTC-derived key would fail here.
const justAfterLocalMidnight = new Date(2026, 6, 20, 0, 30, 0);
assert.equal(localDayKey(justAfterLocalMidnight.getTime()), "2026-07-20");
assert.equal(localDayKey(justAfterLocalMidnight.toISOString()), "2026-07-20");

// Two-digit padding on both halves — the key is sorted as a string.
assert.equal(localDayKey(new Date(2026, 0, 5, 12, 0, 0).getTime()), "2026-01-05");

// Same local day, twelve hours apart: one bucket.
const morning = new Date(2026, 6, 20, 8, 0, 0).getTime();
const evening = new Date(2026, 6, 20, 20, 0, 0).getTime();
assert.equal(localDayKey(morning), localDayKey(evening));

// Twenty-six hours apart: never one bucket.
assert.notEqual(localDayKey(morning), localDayKey(morning + 26 * 3600 * 1000));

// Unusable input returns null rather than a fabricated day.
assert.equal(localDayKey(null), null);
assert.equal(localDayKey(undefined), null);
assert.equal(localDayKey("not a date"), null);

// The label is the cockpit's lowercase chrome voice, and it names the day.
const label = formatLocalDayLabel(justAfterLocalMidnight.getTime());
assert.ok(label !== null && label.length > 0, "a parseable instant gets a label");
assert.equal(label, label.toLowerCase(), "labels are lowercase");
assert.ok(label.includes("20"), `label names the day: ${label}`);
assert.equal(formatLocalDayLabel("not a date"), null);

// The absolute instant NAMES its zone. It stopped doing so once already (the
// suffix was dropped to stop a lifecycle row wrapping), which left every
// absolute stamp unreadable on mobile, where the topbar clock is hidden.
const instant = new Date(2026, 6, 20, 13, 5, 0);
const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
  .formatToParts(instant)
  .find((part) => part.type === "timeZoneName")?.value;
const stamp = formatLocalDateTime(instant.getTime());
assert.ok(
  zone !== undefined && stamp !== null && stamp.includes(zone),
  `absolute stamp names the zone: ${stamp}`,
);

// The short form is the VISIBLE half of the same pair: it keeps the zone (the
// reason the suffix exists) and drops the year (the reason it needed shortening).
const short = formatLocalDateTimeShort(instant.getTime());
assert.ok(
  zone !== undefined && short !== null && short.includes(zone),
  `short stamp names the zone: ${short}`,
);
assert.ok(short !== null && !short.includes("2026"), `short stamp drops the year: ${short}`);

console.log("date-time-format.smoke: ok");
