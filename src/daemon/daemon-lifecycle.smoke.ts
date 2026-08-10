import assert from "node:assert/strict";

import {
  createDaemonLifecycle,
  DaemonLifecycleClosedError,
  DaemonShutdownError,
  runDaemonShutdown,
} from "./daemon-lifecycle.js";

await runDaemonShutdown([
  { name: "first", run: () => undefined },
  { name: "second", run: async () => undefined },
]);

const lifecycleOrder: string[] = [];
const lifecycle = createDaemonLifecycle();
lifecycle.defer({
  name: "database",
  run: () => {
    lifecycleOrder.push("database");
  },
});
lifecycle.defer({
  name: "http-server",
  run: async () => {
    lifecycleOrder.push("http-server");
  },
});

const firstClose = lifecycle.close();
const secondClose = lifecycle.close();
assert.equal(
  secondClose,
  firstClose,
  "lifecycle close should return the in-flight shutdown promise",
);
await firstClose;
await lifecycle.close();
assert.deepEqual(lifecycleOrder, ["http-server", "database"]);
assert.throws(
  () => lifecycle.defer({ name: "late-step", run: () => undefined }),
  (err) =>
    err instanceof DaemonLifecycleClosedError &&
    err.stepName === "late-step",
);

const order: string[] = [];
try {
  await runDaemonShutdown([
    {
      name: "tickers",
      run: () => {
        order.push("tickers");
      },
    },
    {
      name: "runtime-adapters",
      run: () => {
        order.push("runtime-adapters");
        throw new Error("adapter stop failed");
      },
    },
    {
      name: "http-server",
      run: async () => {
        order.push("http-server");
        throw new Error("server close failed");
      },
    },
    {
      name: "database",
      run: () => {
        order.push("database");
      },
    },
  ]);
  assert.fail("expected shutdown failure");
} catch (err) {
  assert(err instanceof DaemonShutdownError);
  assert.deepEqual(order, [
    "tickers",
    "runtime-adapters",
    "http-server",
    "database",
  ]);
  assert.deepEqual(
    err.failures.map((failure) => failure.name),
    ["runtime-adapters", "http-server"],
  );
  assert.match(err.message, /daemon shutdown failed in 2 steps/);
}

console.log("daemon-lifecycle smoke ok");
