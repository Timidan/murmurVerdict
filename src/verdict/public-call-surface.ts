import type Database from "better-sqlite3";

import {
  loadPublicSealedCallView,
} from "./sealed-call-public-projection.js";

const missingCallBody = {
  code: "not_found",
  message: "call not found",
};

export type PublicCallDetailResponse =
  | {
      status: 200;
      body: NonNullable<ReturnType<typeof loadPublicSealedCallView>>;
    }
  | {
      status: 404;
      body: typeof missingCallBody;
    };

export interface PublicCallJsonResponseTarget {
  status(code: number): { json(body: PublicCallDetailResponse["body"]): unknown };
}

export function sendPublicCallJsonResponse(
  res: PublicCallJsonResponseTarget,
  result: PublicCallDetailResponse,
): void {
  res.status(result.status).json(result.body);
}

export function publicCallDetailResponse(input: {
  db: Database.Database;
  callId: string;
}): PublicCallDetailResponse {
  const view = loadPublicSealedCallView({
    db: input.db,
    call_id: input.callId,
    audience: "public-call-detail",
  });
  if (!view) {
    return { status: 404, body: missingCallBody };
  }
  return { status: 200, body: view };
}
