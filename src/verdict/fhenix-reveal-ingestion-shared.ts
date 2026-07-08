import type Database from "better-sqlite3";

import { fhenixSealedCallsRepo } from "./repos/fhenix-sealed-calls-repo.js";
import { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";
import {
  ERROR_CODES,
  type UsageEvent,
  VerdictError,
} from "./schema.js";
import { parseIsoMs } from "./time.js";
import { makeUsageEvent } from "./usage-event.js";

export type SealedRevealTarget =
  | { kind: "not_found" }
  | {
      kind: "sealed";
      ctx: NonNullable<ReturnType<typeof submissionsRepo.loadResolverContext>>;
      sealed: NonNullable<ReturnType<typeof fhenixSealedCallsRepo.byCallId>>;
    };

export function loadSealedRevealTarget(
  db: Database.Database,
  callId: string,
): SealedRevealTarget {
  const ctx = submissionsRepo.loadResolverContext(db, callId);
  if (!ctx) return { kind: "not_found" };
  if (ctx.privacy_mode !== "sealed_fhenix") {
    throw new VerdictError(
      "call is not a sealed_fhenix submission",
      ERROR_CODES.schema_invalid,
      409,
      { privacy_mode: ctx.privacy_mode },
    );
  }
  const sealed = fhenixSealedCallsRepo.byCallId(db, callId);
  if (!sealed) {
    throw new VerdictError(
      "sealed_fhenix metadata missing for call",
      ERROR_CODES.schema_invalid,
      409,
    );
  }
  return { kind: "sealed", ctx, sealed };
}

export function assertRevealWindowOpen(
  revealedAt: string,
  revealOpenAt: string,
  label: string,
): void {
  const revealedAtMs = parseIsoMs(revealedAt, "revealed_at");
  const revealOpenMs = parseIsoMs(revealOpenAt, "reveal_open_at");
  if (revealedAtMs >= revealOpenMs) return;
  throw new VerdictError(
    `${label} cannot be attached before reveal_open_at`,
    ERROR_CODES.schema_invalid,
    400,
    {
      revealed_at: revealedAt,
      reveal_open_at: revealOpenAt,
    },
  );
}

export function makeRevealUsage(
  agent_id: string,
  kind: UsageEvent["kind"],
  attributes: Record<string, unknown>,
  now: () => Date,
): UsageEvent {
  return makeUsageEvent({
    agent_id,
    kind,
    attributes,
    occurredAt: now(),
  });
}
