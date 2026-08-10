import { strict as assert } from "node:assert";

import {
  parseControllerIdentityQuery,
} from "./operator-controller-identity-query.js";

process.stdout.write("murmur operator controller identity query smoke\n");

assert.deepEqual(
  parseControllerIdentityQuery({
    limit: "999",
    due_soon_hours: "9999",
  }),
  {
    limit: 200,
    dueSoonHours: 720,
  },
);

assert.deepEqual(
  parseControllerIdentityQuery({
    limit: ["0", "10"],
    due_soon_hours: "0",
  }),
  {
    limit: 1,
    dueSoonHours: 1,
  },
);

assert.deepEqual(
  parseControllerIdentityQuery({
    limit: "bad",
    due_soon_hours: "later",
  }),
  {
    limit: 50,
    dueSoonHours: 24,
  },
);

process.stdout.write("  ok operator controller identity query owns due-soon policy\n");
