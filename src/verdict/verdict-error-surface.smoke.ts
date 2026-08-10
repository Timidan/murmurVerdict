import { strict as assert } from "node:assert";

import type { NextFunction, Request, Response } from "express";

import {
  createVerdictErrorHandler,
  verdictErrorResponse,
} from "./verdict-error-surface.js";
import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

process.stdout.write("murmur verdict error surface smoke\n");

const logger = {
  entries: [] as unknown[][],
  error(...args: unknown[]) {
    this.entries.push(args);
  },
};

class FakeResponse {
  statusCode = 200;
  body: unknown = null;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

assert.deepEqual(
  verdictErrorResponse(
    new VerdictError(
      "agent cannot perform action",
      ERROR_CODES.agent_not_authorized,
      403,
      { agent_id: "agent-1" },
    ),
    logger,
  ),
  {
    status: 403,
    body: {
      code: ERROR_CODES.agent_not_authorized,
      message: "agent cannot perform action",
      context: { agent_id: "agent-1" },
    },
  },
);
assert.equal(logger.entries.length, 0);

assert.deepEqual(
  verdictErrorResponse(new SyntaxError("Unexpected token"), logger),
  {
    status: 400,
    body: {
      code: ERROR_CODES.schema_invalid,
      message: "invalid JSON body",
    },
  },
);
assert.equal(logger.entries.length, 0);

const unknown = new Error("database unavailable");
assert.deepEqual(verdictErrorResponse(unknown, logger), {
  status: 500,
  body: {
    code: ERROR_CODES.internal_error,
    message: "internal error",
  },
});
assert.deepEqual(logger.entries, [["[verdict-api]", unknown]]);

const response = new FakeResponse();
createVerdictErrorHandler(logger)(
  new VerdictError("bad input", ERROR_CODES.schema_invalid, 400),
  {} as Request,
  response as unknown as Response,
  (() => undefined) as NextFunction,
);
assert.equal(response.statusCode, 400);
assert.deepEqual(response.body, {
  code: ERROR_CODES.schema_invalid,
  message: "bad input",
});

process.stdout.write("verdict error surface smoke ok\n");
