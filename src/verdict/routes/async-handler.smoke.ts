import { strict as assert } from "node:assert";

import { asyncHandler } from "./async-handler.js";

process.stdout.write("murmur async route handler smoke\n");

const calls: unknown[] = [];
const handled = asyncHandler(async (_req, res) => {
  calls.push("handled");
  res.status(204).end();
});

await new Promise<void>((resolve, reject) => {
  handled(
    {} as Parameters<typeof handled>[0],
    {
      status(code: number) {
        assert.equal(code, 204);
        calls.push("status");
        return this;
      },
      end() {
        calls.push("end");
        resolve();
      },
    } as Parameters<typeof handled>[1],
    reject,
  );
});
assert.deepEqual(calls, ["handled", "status", "end"]);

const err = new Error("boom");
const rejected = asyncHandler(async () => {
  throw err;
});
await new Promise<void>((resolve, reject) => {
  rejected(
    {} as Parameters<typeof rejected>[0],
    {} as Parameters<typeof rejected>[1],
    (nextErr?: unknown) => {
      try {
        assert.equal(nextErr, err);
        resolve();
      } catch (assertErr) {
        reject(assertErr);
      }
    },
  );
});

process.stdout.write("  ok async route handler forwards rejections\n");
