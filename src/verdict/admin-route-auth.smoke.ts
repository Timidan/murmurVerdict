import { strict as assert } from "node:assert";
import type { Request, Response } from "express";

import {
  adminRouteAuthDecision,
  createAdminRouteAuth,
  sendAdminRouteAuthFailure,
} from "./admin-route-auth.js";

process.stdout.write("murmur Admin Route Auth smoke\n");

const equals = (a: string | undefined | null, b: string | undefined | null) =>
  a === b;

assert.deepEqual(
  adminRouteAuthDecision({
    adminToken: "",
    requirement: "header_or_bearer",
    secretEquals: equals,
  }),
  {
    authorized: false,
    failure: {
      status: 503,
      body: {
        code: "admin_disabled",
        message: "VERDICT_ADMIN_TOKEN not set",
      },
    },
  },
);

assert.deepEqual(
  adminRouteAuthDecision({
    adminToken: "",
    requirement: "bearer",
    bearerToken: "admin-token",
    secretEquals: equals,
  }),
  {
    authorized: false,
    failure: {
      status: 403,
      body: {
        code: "admin_forbidden",
        message: "valid admin bearer token required",
      },
    },
  },
);

assert.deepEqual(
  adminRouteAuthDecision({
    adminToken: "admin-token",
    requirement: "header_or_bearer",
    bearerToken: "admin-token",
    secretEquals: equals,
  }),
  { authorized: true },
);
assert.deepEqual(
  adminRouteAuthDecision({
    adminToken: "admin-token",
    requirement: "header",
    headerToken: "wrong-token",
    secretEquals: equals,
  }),
  {
    authorized: false,
    failure: {
      status: 403,
      body: {
        code: "admin_forbidden",
        message: "admin token required",
      },
    },
  },
);

const failureTarget = makeStatusJsonTarget();
sendAdminRouteAuthFailure(failureTarget, {
  status: 403,
  body: { code: "admin_forbidden", message: "admin token required" },
});
assert.equal(failureTarget.statusCode, 403);
assert.deepEqual(failureTarget.body, {
  code: "admin_forbidden",
  message: "admin token required",
});

const auth = createAdminRouteAuth("admin-token");
assert.equal(auth.adminEnabled, true);
assert.equal(
  auth.requireAdmin(
    fakeRequest({ authorization: "Bearer admin-token" }),
    makeStatusJsonTarget() as unknown as Response,
  ),
  true,
);

const missingHeaderTarget = makeStatusJsonTarget();
assert.equal(
  auth.requireAdminHeader(
    fakeRequest({ "x-admin-token": "wrong-token" }),
    missingHeaderTarget as unknown as Response,
  ),
  false,
);
assert.equal(missingHeaderTarget.statusCode, 403);
assert.deepEqual(missingHeaderTarget.body, {
  code: "admin_forbidden",
  message: "admin token required",
});

const disabled = createAdminRouteAuth("");
const disabledTarget = makeStatusJsonTarget();
assert.equal(
  disabled.requireAdmin(
    fakeRequest({ authorization: "Bearer admin-token" }),
    disabledTarget as unknown as Response,
  ),
  false,
);
assert.equal(disabledTarget.statusCode, 503);
assert.deepEqual(disabledTarget.body, {
  code: "admin_disabled",
  message: "VERDICT_ADMIN_TOKEN not set",
});

process.stdout.write("Admin Route Auth smoke ok\n");

function fakeRequest(headers: Record<string, string>): Request {
  return {
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

function makeStatusJsonTarget() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return {
        json: (body: unknown) => {
          this.body = body;
        },
      };
    },
  };
}
