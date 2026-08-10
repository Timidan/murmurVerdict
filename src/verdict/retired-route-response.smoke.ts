import { strict as assert } from "node:assert";

import {
  retiredRouteBody,
  sendRetiredRoute,
  type RetiredRouteResponse,
  type RetiredRouteResponseBody,
} from "./retired-route-response.js";

process.stdout.write("murmur retired route response smoke\n");

assert.deepEqual(retiredRouteBody({
  message: "old path is retired",
  replacement: "/new/path",
}), {
  code: "endpoint_removed",
  message: "old path is retired",
  replacement: "/new/path",
});
assert.deepEqual(retiredRouteBody({ message: "deferred" }), {
  code: "endpoint_removed",
  message: "deferred",
});

let statusCode = 0;
let body: RetiredRouteResponseBody | null = null;
const fakeRes: RetiredRouteResponse = {
  status(code: 410) {
    statusCode = code;
    return {
      json(payload: RetiredRouteResponseBody) {
        body = payload;
      },
    };
  },
};
sendRetiredRoute(fakeRes, {
  message: "old feed path is retired",
  replacement: "/v2/gateway/feeds/:feed_id/packets",
});
assert.equal(statusCode, 410);
assert.deepEqual(body, {
  code: "endpoint_removed",
  message: "old feed path is retired",
  replacement: "/v2/gateway/feeds/:feed_id/packets",
});

process.stdout.write("  ok retired routes share 410 response shape\n");
