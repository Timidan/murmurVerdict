import type { Request, Response } from "express";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { ERROR_CODES, VerdictError } from "./schema.js";
import { verdictErrorResponse } from "./verdict-error-surface.js";

export interface AdminRouteAuth {
  adminEnabled: boolean;
  requireAdmin: (req: Request, res: Response) => boolean;
  requireAdminBearer: (req: Request, res: Response) => boolean;
  requireAdminHeader: (req: Request, res: Response) => boolean;
  secretEquals: (a: string | undefined | null, b: string | undefined | null) => boolean;
}

export type AdminRouteAuthRequirement = "header_or_bearer" | "bearer" | "header";

export interface AdminRouteAuthErrorBody {
  code: typeof ERROR_CODES.admin_disabled | typeof ERROR_CODES.admin_forbidden;
  message: string;
}

export interface AdminRouteAuthFailure {
  status: 403 | 503;
  body: AdminRouteAuthErrorBody;
}

export type AdminRouteAuthDecision =
  | { authorized: true }
  | { authorized: false; failure: AdminRouteAuthFailure };

export interface AdminRouteAuthResponseTarget {
  status(code: number): {
    json(body: unknown): unknown;
  };
}

export function createAdminRouteAuth(adminToken: string): AdminRouteAuth {
  const requireAdmin = (req: Request, res: Response): boolean => {
    return requireAdminRoute(req, res, adminToken, "header_or_bearer");
  };

  const requireAdminBearer = (req: Request, res: Response): boolean => {
    return requireAdminRoute(req, res, adminToken, "bearer");
  };

  const requireAdminHeader = (req: Request, res: Response): boolean => {
    return requireAdminRoute(req, res, adminToken, "header");
  };

  return {
    adminEnabled: Boolean(adminToken),
    requireAdmin,
    requireAdminBearer,
    requireAdminHeader,
    secretEquals: safeStrEq,
  };
}

export function adminRouteAuthDecision(input: {
  adminToken: string;
  requirement: AdminRouteAuthRequirement;
  headerToken?: string | null;
  bearerToken?: string | null;
  secretEquals?: (a: string | undefined | null, b: string | undefined | null) => boolean;
}): AdminRouteAuthDecision {
  const secretEquals = input.secretEquals ?? safeStrEq;
  if (!input.adminToken && input.requirement !== "bearer") {
    return {
      authorized: false,
      failure: {
        status: 503,
        body: {
          code: ERROR_CODES.admin_disabled,
          message: "VERDICT_ADMIN_TOKEN not set",
        },
      },
    };
  }
  if (input.requirement === "header_or_bearer") {
    const ok =
      secretEquals(input.headerToken, input.adminToken) ||
      secretEquals(input.bearerToken, input.adminToken);
    return ok ? { authorized: true } : adminTokenRequired();
  }
  if (input.requirement === "header") {
    return secretEquals(input.headerToken, input.adminToken)
      ? { authorized: true }
      : adminTokenRequired();
  }
  return input.adminToken && secretEquals(input.bearerToken, input.adminToken)
    ? { authorized: true }
    : validAdminBearerRequired();
}

export function sendAdminRouteAuthFailure(
  res: AdminRouteAuthResponseTarget,
  failure: AdminRouteAuthFailure,
): void {
  // Render through the shared Verdict Error Surface so the envelope matches every other error.
  const result = verdictErrorResponse(
    new VerdictError(failure.body.message, failure.body.code, failure.status),
  );
  res.status(result.status).json(result.body);
}

function requireAdminRoute(
  req: Request,
  res: Response,
  adminToken: string,
  requirement: AdminRouteAuthRequirement,
): boolean {
  const decision = adminRouteAuthDecision({
    adminToken,
    requirement,
    headerToken: req.header("X-Admin-Token"),
    bearerToken: bearerToken(req),
  });
  if (decision.authorized) return true;
  sendAdminRouteAuthFailure(res, decision.failure);
  return false;
}

function adminTokenRequired(): AdminRouteAuthDecision {
  return {
    authorized: false,
    failure: {
      status: 403,
      body: {
        code: ERROR_CODES.admin_forbidden,
        message: "admin token required",
      },
    },
  };
}

function validAdminBearerRequired(): AdminRouteAuthDecision {
  return {
    authorized: false,
    failure: {
      status: 403,
      body: {
        code: ERROR_CODES.admin_forbidden,
        message: "valid admin bearer token required",
      },
    },
  };
}

/** Constant-time equality: HMACs both sides with a per-process key, so length and value mismatches cost the same. */
let safeStrEqKey: Buffer | null = null;
function safeStrEq(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (safeStrEqKey === null) safeStrEqKey = randomBytes(32);
  const hashOf = (s: string): Buffer =>
    createHmac("sha256", safeStrEqKey!).update(s, "utf8").digest();
  return timingSafeEqual(hashOf(a), hashOf(b));
}

function bearerToken(req: Request): string | null {
  const raw = req.header("authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1] ?? null;
}
