import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  nowIso,
  publicControllerWalletRow,
} from "./agent-identity.js";
import {
  AgentAlreadyOwnedError,
  getControllerWalletForAgent,
  linkAgentToAccount,
  listAccountAgents,
} from "./auth/accounts.js";
import { agentsRepo } from "./repos/agents-repo.js";
import {
  AgentSlugSchema,
  ERROR_CODES,
  VerdictError,
} from "./schema.js";

const CreateAgentSchema = z.object({
  display_slug: AgentSlugSchema,
  display_name: z.string().min(1).max(120),
  bio: z.string().max(500).optional(),
});

export interface AccountAgentSurfaceBase {
  db: Database.Database;
  accountId: string;
}

export interface AccountAgentWriteClock {
  now: () => Date;
}

export interface AccountAgentReadInstant {
  servedAt: Date;
}

export type AccountAgentIdAdapter = () => string;

export interface AccountAgentJsonResponse {
  status: 200 | 201;
  body: unknown;
}

export interface AccountAgentJsonResponseTarget {
  status(code: number): { json(body: unknown): unknown };
}

export function sendAccountAgentJsonResponse(
  res: AccountAgentJsonResponseTarget,
  result: AccountAgentJsonResponse,
): void {
  res.status(result.status).json(result.body);
}

export function createAccountAgentResponse(
  input: AccountAgentSurfaceBase & AccountAgentWriteClock & {
    body: unknown;
    newAgentId?: AccountAgentIdAdapter;
  },
): {
  status: 201;
  body: {
    agent_id: string;
    display_slug: string;
    display_name: string;
    kind: "agent";
    created_at: string;
  };
} {
  const parsed = CreateAgentSchema.safeParse(input.body);
  if (!parsed.success) {
    throwInvalidRequest(parsed.error.issues);
  }
  const operationNow = input.now();
  const ts = nowIso(() => operationNow);
  const agentId = input.newAgentId?.() ?? randomUUID();
  try {
    input.db.transaction(() => {
      agentsRepo.insert(
        input.db,
        {
          agent_id: agentId,
          display_slug: parsed.data.display_slug,
          kind: "agent",
          display_name: parsed.data.display_name,
          bio: parsed.data.bio,
          created_at: ts,
        },
      );
      linkAgentToAccount(input.db, input.accountId, agentId, {
        linkedAt: operationNow,
      });
    })();
  } catch (err) {
    if (
      err instanceof Error &&
      /UNIQUE.+display_slug/i.test(err.message)
    ) {
      throw new VerdictError(
        "display_slug already taken",
        ERROR_CODES.duplicate,
        409,
      );
    }
    if (err instanceof AgentAlreadyOwnedError) {
      throw new VerdictError(
        err.message,
        ERROR_CODES.agent_already_owned_by_another_account,
        409,
        { agent_id: err.agent_id },
      );
    }
    throw err;
  }
  return {
    status: 201,
    body: {
      agent_id: agentId,
      display_slug: parsed.data.display_slug,
      display_name: parsed.data.display_name,
      kind: "agent",
      created_at: ts,
    },
  };
}

export function listAccountAgentsResponse(
  input: AccountAgentSurfaceBase & AccountAgentReadInstant,
): {
  status: 200;
  body: {
    agents: Array<{
      agent_id: string;
      linked_at: string;
      display_slug: string | null;
      display_name: string | null;
      kind: string | null;
      wallet_address: string | null;
      chain_id: string | null;
      controller_wallet: ReturnType<typeof publicControllerWalletRow> | null;
      destination_address: string | null;
      destination_address_updated_at: string | null;
    }>;
  };
} {
  const rows = listAccountAgents(input.db, input.accountId);
  const readClock = () => input.servedAt;
  const destRowStmt = input.db.prepare(
    "SELECT destination_address, destination_address_updated_at FROM agents WHERE agent_id = ?",
  );
  const agents = rows.map((row) => {
    const agent = agentsRepo.byId(input.db, row.agent_id);
    const controller = getControllerWalletForAgent(input.db, row.agent_id);
    const dest = destRowStmt.get(row.agent_id) as
      | {
          destination_address: string | null;
          destination_address_updated_at: string | null;
        }
      | undefined;
    return {
      agent_id: row.agent_id,
      linked_at: row.created_at,
      display_slug: agent?.display_slug ?? null,
      display_name: agent?.display_name ?? null,
      kind: agent?.kind ?? null,
      wallet_address: agent?.wallet_address ?? null,
      chain_id: agent?.chain_id ?? null,
      controller_wallet: controller
        ? publicControllerWalletRow(controller, readClock)
        : null,
      destination_address: dest?.destination_address ?? null,
      destination_address_updated_at:
        dest?.destination_address_updated_at ?? null,
    };
  });
  return { status: 200, body: { agents } };
}

function throwInvalidRequest(issues: z.ZodIssue[]): never {
  throw new VerdictError(
    "invalid request",
    ERROR_CODES.schema_invalid,
    400,
    { issues },
  );
}
