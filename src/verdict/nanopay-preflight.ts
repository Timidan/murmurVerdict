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
 * Rejects before the SDK settles payment on a malformed pipelineId, unknown pipeline, or no
 * anchored signal, so buyers aren't charged.
 */
export function preflightServable(deps: NanopayRouterDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Signed requests go to the durable gate first so a settled authorization can replay after a
    // pipeline is retired; new signed payments are preflighted there before settlement.
    if (req.headers?.["payment-signature"] !== undefined) {
      next();
      return;
    }
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
