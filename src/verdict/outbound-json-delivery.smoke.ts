import { strict as assert } from "node:assert";

import {
  deliverOutboundJson,
  outboundJsonDeliveryRequest,
  type OutboundJsonDeliveryFetch,
  type OutboundJsonDeliveryTimers,
} from "./outbound-json-delivery.js";

process.stdout.write("murmur Outbound JSON Delivery smoke\n");

const signal = new AbortController().signal;
const request = outboundJsonDeliveryRequest({
  url: "https://hooks.example/callback",
  body: JSON.stringify({ ok: true }),
  headers: {
    "User-Agent": "murmur-smoke/0.1",
    "X-Murmur-Test": "yes",
  },
  signal,
});
assert.equal(request.url, "https://hooks.example/callback");
assert.equal(request.body, "{\"ok\":true}");
assert.equal(request.init.method, "POST");
assert.equal(request.init.redirect, "error");
assert.equal(request.init.signal, signal);
assert.deepEqual(request.init.headers, {
  "Content-Type": "application/json",
  "User-Agent": "murmur-smoke/0.1",
  "X-Murmur-Test": "yes",
});

const captured: Array<{ url: string; init: RequestInit }> = [];
let bodyDrained = false;
const fetchOk: OutboundJsonDeliveryFetch = async (url, init) => {
  captured.push({ url, init });
  return {
    status: 202,
    ok: true,
    text: async () => {
      bodyDrained = true;
      return "accepted";
    },
  };
};
const timers = fakeTimers();
const ok = await deliverOutboundJson({
  url: "https://hooks.example/callback",
  body: "{\"ok\":true}",
  headers: { "X-Murmur-Test": "yes" },
  timeoutMs: 1234,
  fetch: fetchOk,
  timers,
});
assert.deepEqual(ok, { ok: true, status: 202, error: null });
assert.equal(captured[0]?.url, "https://hooks.example/callback");
assert.equal(captured[0]?.init.method, "POST");
assert.equal((captured[0]?.init.headers as Record<string, string>)["X-Murmur-Test"], "yes");
assert.equal(timers.scheduledMs[0], 1234);
assert.equal(timers.cleared[0], "timeout-1");
assert.equal(bodyDrained, true);

const nonOk = await deliverOutboundJson({
  url: "https://hooks.example/callback",
  body: "{}",
  timeoutMs: 500,
  fetch: async () => ({ status: 503, ok: false, text: async () => "busy" }),
  timers: fakeTimers(),
});
assert.deepEqual(nonOk, { ok: false, status: 503, error: "http status 503" });

const thrown = await deliverOutboundJson({
  url: "https://hooks.example/callback",
  body: "{}",
  timeoutMs: 500,
  fetch: async () => {
    throw new Error("network down");
  },
  timers: fakeTimers(),
});
assert.deepEqual(thrown, { ok: false, status: null, error: "network down" });

process.stdout.write("Outbound JSON Delivery smoke ok\n");

function fakeTimers(): OutboundJsonDeliveryTimers & {
  scheduledMs: number[];
  cleared: unknown[];
} {
  let count = 0;
  return {
    scheduledMs: [],
    cleared: [],
    setTimeout(msCallback: () => void, ms: number): unknown {
      void msCallback;
      count++;
      this.scheduledMs.push(ms);
      return `timeout-${count}`;
    },
    clearTimeout(handle: unknown): void {
      this.cleared.push(handle);
    },
  };
}
