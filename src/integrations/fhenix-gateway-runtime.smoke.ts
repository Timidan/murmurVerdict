import assert from "node:assert/strict";

import {
  withTimeout,
  type FhenixGatewayRuntimeTimers,
} from "./fhenix-gateway-runtime.js";

process.stdout.write("murmur Fhenix Gateway Runtime Primitives smoke\n");

const timers = fakeTimers();
const timeoutResult = withTimeout(
  new Promise<string>(() => undefined),
  250,
  "submitSealedFor",
  timers,
);
assert.deepEqual(timers.scheduled.map((handle) => handle.ms), [250]);
timers.scheduled[0]?.callback();
await assert.rejects(
  () => timeoutResult,
  /submitSealedFor timed out after 250ms/,
);
assert.deepEqual(timers.cleared, timers.scheduled);

const successTimers = fakeTimers();
assert.equal(
  await withTimeout(
    Promise.resolve("submitted"),
    500,
    "submitFeedPacketFor",
    successTimers,
  ),
  "submitted",
);
assert.deepEqual(successTimers.scheduled.map((handle) => handle.ms), [500]);
assert.deepEqual(successTimers.cleared, successTimers.scheduled);

const disabledTimers = fakeTimers();
assert.equal(
  await withTimeout(
    Promise.resolve("without-timeout"),
    0,
    "disabled",
    disabledTimers,
  ),
  "without-timeout",
);
assert.deepEqual(disabledTimers.scheduled, []);
assert.deepEqual(disabledTimers.cleared, []);

process.stdout.write("Fhenix Gateway Runtime Primitives smoke ok\n");

type TimerHandle = {
  callback: () => void;
  ms: number;
};

function fakeTimers(): FhenixGatewayRuntimeTimers & {
  cleared: TimerHandle[];
  scheduled: TimerHandle[];
} {
  const scheduled: TimerHandle[] = [];
  const cleared: TimerHandle[] = [];
  return {
    scheduled,
    cleared,
    setTimeout(callback, ms) {
      const handle = { callback, ms };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle as TimerHandle);
    },
  };
}
