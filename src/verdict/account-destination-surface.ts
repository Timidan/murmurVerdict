import type Database from "better-sqlite3";
import { z } from "zod";

import {
  requireOwnedAgentBySlug,
} from "./agent-identity.js";
import {
  DESTINATION_ADDRESS_COOLDOWN_MS,
  setDestinationAddress,
} from "./auth/accounts.js";
import { usageRepo } from "./repos/usage-events-repo.js";
import {
  ERROR_CODES,
  VerdictError,
  WalletAddressSchema,
} from "./schema.js";
import { makeUsageEvent, type UsageEventIdAdapter } from "./usage-event.js";

const SetDestinationSchema = z.object({
  destination_address: WalletAddressSchema,
});

export interface AccountDestinationJsonResponse {
  status: 200 | 429;
  body: unknown;
}

export interface AccountDestinationJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export interface AccountDestinationSurfaceBase {
  db: Database.Database;
  accountId: string;
  slug: string;
}

export interface AccountDestinationWriteClock {
  now: () => Date;
}

export interface AccountDestinationCooldownPolicy {
  destinationCooldownMs?: number;
}

export interface AccountDestinationEvidenceAdapters {
  newUsageEventId?: UsageEventIdAdapter;
}

export function sendAccountDestinationJsonResponse(
  res: AccountDestinationJsonResponseTarget,
  result: AccountDestinationJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export function setAccountDestinationAddressResponse(
  input: AccountDestinationSurfaceBase
    & AccountDestinationWriteClock
    & AccountDestinationCooldownPolicy
    & AccountDestinationEvidenceAdapters
    & {
      body: unknown;
    },
):
  | {
      status: 200;
      body: {
        agent_id: string;
        destination_address: string;
        destination_address_updated_at: string;
      };
    }
  | {
      status: 429;
      body: {
        error: string;
        code: typeof ERROR_CODES.rate_limited;
        retry_after_seconds: number | undefined;
      };
    } {
  const agent = requireOwnedAgentBySlug(input.db, input.accountId, input.slug);
  const parsed = SetDestinationSchema.safeParse(input.body);
  if (!parsed.success) {
    throw new VerdictError(
      "invalid request",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.issues },
    );
  }
  const cooldownMs = input.destinationCooldownMs ?? DESTINATION_ADDRESS_COOLDOWN_MS;
  const operationNow = input.now();
  const result = input.db.transaction(() => {
    const setResult = setDestinationAddress(input.db, {
      agent_id: agent.agent_id,
      destination_address: parsed.data.destination_address,
      cooldownMs,
      updatedAt: operationNow,
    });
    if (setResult.ok) {
      usageRepo.emit(
        input.db,
        makeUsageEvent({
          agent_id: agent.agent_id,
          kind: "destination_address_updated",
          attributes: {
            previous_address: setResult.previous_address ?? null,
            new_address: parsed.data.destination_address,
            cooldown_ms: cooldownMs,
          },
          newUsageEventId: input.newUsageEventId,
          occurredAt: operationNow,
        }),
      );
    }
    return setResult;
  })();

  if (!result.ok) {
    if (result.reason === "cooldown_active") {
      return {
        status: 429,
        body: {
          error: "destination_address cooldown active",
          code: ERROR_CODES.rate_limited,
          retry_after_seconds: result.retry_after_seconds,
        },
      };
    }
    throw new VerdictError(
      "agent not found",
      ERROR_CODES.unknown_agent,
      404,
    );
  }

  return {
    status: 200,
    body: {
      agent_id: agent.agent_id,
      destination_address: parsed.data.destination_address,
      destination_address_updated_at: result.updated_at,
    },
  };
}
