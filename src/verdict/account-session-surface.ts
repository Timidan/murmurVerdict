import type { ResolvedAccount } from "./account-route-auth.js";

export interface AccountSessionJsonResponse {
  status: 200;
  body: {
    account_id: string;
    created: boolean;
    privy_user_id: string;
  };
}

export interface AccountSessionJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendAccountSessionJsonResponse(
  res: AccountSessionJsonResponseTarget,
  result: AccountSessionJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export function accountSessionResponse(
  resolved: ResolvedAccount,
): AccountSessionJsonResponse {
  return {
    status: 200,
    body: {
      account_id: resolved.account_id,
      created: resolved.created,
      privy_user_id: resolved.claims.privy_user_id,
    },
  };
}
