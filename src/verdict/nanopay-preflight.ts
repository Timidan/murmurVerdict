import type { NextFunction, Request, Response } from "express";

import type { NanopayRouterDeps } from "./nanopay-types.js";
import { extractPipelineId } from "./nanopay-request.js";

export interface NanopayPreflightResult {
  ok: boolean;
  status?: number;
  body?: unknown;
}

export interface NanopayPreflightJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendNanopayPreflightJsonResponse(
  res: NanopayPreflightJsonResponseTarget,
  result: NanopayPreflightResult,
): void {
  if (result.ok) return;
  res.status(result.status ?? 500).json(result.body ?? { error: "PreflightFailed" });
}

export function nanopayPreflightResponse(input: {
  deps: NanopayRouterDeps;
  pipelineId: string | null;
}): NanopayPreflightResult {
  const { deps, pipelineId } = input;
  if (!pipelineId) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "BadPipelineId",
        message: "pipelineId must be 32-byte hex",
      },
    };
  }
  const pipeline = deps.resolvePipeline(pipelineId);
  if (!pipeline) {
    return {
      ok: false,
      status: 404,
      body: { error: "PipelineNotFound", pipelineId },
    };
  }
  const sealedCall = deps.resolveLatestSealedCall(pipelineId);
  if (!sealedCall) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "NoSignalAvailable",
        message:
          "Pipeline has no anchored sealed-Fhenix call yet; retry once the agent has submitted.",
      },
    };
  }
  return { ok: true };
}

/**
 * Pre-middleware servable check. Rejects the request BEFORE the SDK
 * middleware settles payment if:
 *   - pipelineId path param is malformed.
 *   - resolvePipeline returns null (unknown pipeline).
 *   - resolveLatestSealedCall returns null (no signal anchored yet).
 *
 * Buyers don't get charged in any of these cases. Operator visibility
 * is via standard 4xx/5xx responses + access logs.
 */
export function preflightServable(deps: NanopayRouterDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = nanopayPreflightResponse({
      deps,
      pipelineId: extractPipelineId(req),
    });
    if (!result.ok) {
      sendNanopayPreflightJsonResponse(res, result);
      return;
    }
    next();
  };
}
