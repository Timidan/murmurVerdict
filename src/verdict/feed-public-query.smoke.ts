import { strict as assert } from "node:assert";

import {
  feedPublicDetailQuery,
  feedPublicListQuery,
} from "./feed-public-query.js";
import { VerdictError } from "./schema.js";

process.stdout.write("murmur Feed Public Query smoke\n");

assert.deepEqual(feedPublicListQuery(undefined), {
  status: undefined,
  venue: undefined,
  agentSlug: undefined,
  limit: 100,
  edgeClass: null,
  resolutionClass: null,
});
assert.deepEqual(
  feedPublicListQuery({
    status: "listed",
    venue: "native-price",
    agent_slug: ["maya", "ignored"],
    limit: "9.8",
    edge_class: "latency",
    resolution_class: "price_direction",
  }),
  {
    status: "listed",
    venue: "native-price",
    agentSlug: "maya",
    limit: 9,
    edgeClass: "latency",
    resolutionClass: "price_direction",
  },
);
assert.deepEqual(feedPublicListQuery({ limit: "9999" }).limit, 500);
assert.throws(
  () => feedPublicListQuery({ status: "bad-status" }),
  (err) =>
    err instanceof VerdictError &&
    err.httpStatus === 400 &&
    err.code === "schema_invalid" &&
    err.message.includes("status must be one of"),
);
assert.throws(
  () => feedPublicListQuery({ edge_class: "bad-edge" }),
  (err) =>
    err instanceof VerdictError &&
    err.httpStatus === 400 &&
    err.code === "schema_invalid" &&
    err.message.includes("edge_class must be one of"),
);
assert.throws(
  () => feedPublicListQuery({ resolution_class: "bad-resolution" }),
  (err) =>
    err instanceof VerdictError &&
    err.httpStatus === 400 &&
    err.code === "schema_invalid" &&
    err.message.includes("resolution_class must be one of"),
);
assert.deepEqual(feedPublicDetailQuery(undefined), { includePackets: false });
assert.deepEqual(feedPublicDetailQuery({ include_packets: "true" }), {
  includePackets: true,
});
assert.deepEqual(feedPublicDetailQuery({ include_packets: ["true", "false"] }), {
  includePackets: true,
});
assert.deepEqual(feedPublicDetailQuery({ include_packets: "false" }), {
  includePackets: false,
});

process.stdout.write("Feed Public Query smoke ok\n");
