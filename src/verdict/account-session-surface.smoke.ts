import { strict as assert } from "node:assert";

import {
  accountSessionResponse,
  sendAccountSessionJsonResponse,
} from "./account-session-surface.js";

process.stdout.write("murmur Account Session Surface smoke\n");

const result = accountSessionResponse({
  account_id: "account-1",
  created: true,
  claims: {
    privy_user_id: "did:privy:user-1",
    session_id: "session-1",
    expires_at: "2026-06-12T10:30:00Z",
  },
});

assert.deepEqual(result, {
  status: 200,
  body: {
    account_id: "account-1",
    created: true,
    privy_user_id: "did:privy:user-1",
  },
});

const target = {
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
sendAccountSessionJsonResponse(target, result);
assert.equal(target.statusCode, 200);
assert.equal(target.body, result.body);

process.stdout.write("Account Session Surface smoke ok\n");
