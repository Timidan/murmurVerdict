import assert from "node:assert/strict";

import {
  loadWebhookUrlPolicy,
  resolveWebhookDestination,
  validateWebhookUrl,
  type WebhookDnsLookup,
  WebhookUrlPolicyConfigError,
} from "./webhook-url.js";

const priorAllowHttp = process.env.WEBHOOK_ALLOW_HTTP;
process.env.WEBHOOK_ALLOW_HTTP = "1";

try {
  assert.equal(loadWebhookUrlPolicy({}).allowHttp, false);
  assert.equal(loadWebhookUrlPolicy({ WEBHOOK_ALLOW_HTTP: "YES" }).allowHttp, true);
  assert.equal(loadWebhookUrlPolicy({ WEBHOOK_ALLOW_HTTP: "0" }).allowHttp, false);
  assert.throws(
    () => loadWebhookUrlPolicy({ WEBHOOK_ALLOW_HTTP: "maybe" }),
    (err) =>
      err instanceof WebhookUrlPolicyConfigError &&
      err.key === "WEBHOOK_ALLOW_HTTP",
  );

  const explicitDeny = await validateWebhookUrl("http://1.1.1.1/hook", {
    allowHttp: false,
  });
  assert.deepEqual(explicitDeny, {
    ok: false,
    reason: "url must use https://",
  });

  const explicitAllow = await validateWebhookUrl("http://1.1.1.1/hook", {
    allowHttp: true,
  });
  assert.deepEqual(explicitAllow, {
    ok: true,
    url: "http://1.1.1.1/hook",
  });

  const lookedUp: string[] = [];
  const publicDnsLookup: WebhookDnsLookup = async (hostname) => {
    lookedUp.push(hostname);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const publicHostname = await validateWebhookUrl(
    "https://hooks.example/murmur",
    { allowHttp: false },
    { dnsLookup: publicDnsLookup },
  );
  assert.deepEqual(publicHostname, {
    ok: true,
    url: "https://hooks.example/murmur",
  });
  assert.deepEqual(lookedUp, ["hooks.example"]);

  const pinned = await resolveWebhookDestination(
    "https://hooks.example/murmur",
    { allowHttp: false },
    { dnsLookup: publicDnsLookup },
  );
  assert.deepEqual(pinned, {
    ok: true,
    url: "https://hooks.example/murmur",
    address: "93.184.216.34",
    family: 4,
  });

  const privateHostname = await validateWebhookUrl(
    "https://private.example/murmur",
    { allowHttp: false },
    { dnsLookup: async () => [{ address: "10.0.0.5", family: 4 }] },
  );
  assert.deepEqual(privateHostname, {
    ok: false,
    reason: "hostname resolves to a private/reserved address",
  });

  for (const privateAddress of [
    "::ffff:7f00:1",
    "fe90::1",
    "2001:db8::1",
  ]) {
    const denied = await resolveWebhookDestination(
      "https://private.example/murmur",
      { allowHttp: false },
      { dnsLookup: async () => [{ address: privateAddress, family: 6 }] },
    );
    assert.deepEqual(denied, {
      ok: false,
      reason: "hostname resolves to a private/reserved address",
    });
  }

  const unresolvedHostname = await validateWebhookUrl(
    "https://missing.example/murmur",
    { allowHttp: false },
    { dnsLookup: async () => [] },
  );
  assert.deepEqual(unresolvedHostname, {
    ok: false,
    reason: "hostname did not resolve",
  });

  console.log("webhook-url smoke ok");
} finally {
  if (priorAllowHttp === undefined) delete process.env.WEBHOOK_ALLOW_HTTP;
  else process.env.WEBHOOK_ALLOW_HTTP = priorAllowHttp;
}
