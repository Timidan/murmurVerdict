import type { NextFunction, Request, Response } from "express";

import {
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

export interface VerdictErrorSurfaceLogger {
  error: (...args: unknown[]) => void;
}

export interface VerdictErrorSurfaceResult {
  status: number;
  body: Record<string, unknown>;
}

export function verdictErrorResponse(
  err: unknown,
  logger: VerdictErrorSurfaceLogger = console,
): VerdictErrorSurfaceResult {
  if (err instanceof VerdictError) {
    return {
      status: err.httpStatus,
      body: {
        code: err.code,
        message: err.message,
        ...(err.context ? { context: err.context } : {}),
      },
    };
  }
  if (err instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        code: ERROR_CODES.schema_invalid,
        message: "invalid JSON body",
      },
    };
  }
  logger.error("[verdict-api]", err);
  return {
    status: 500,
    body: {
      code: ERROR_CODES.internal_error,
      message: "internal error",
    },
  };
}

export function createVerdictErrorHandler(
  logger: VerdictErrorSurfaceLogger = console,
) {
  return (
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void => {
    const result = verdictErrorResponse(err, logger);
    res.status(result.status).json(result.body);
  };
}
