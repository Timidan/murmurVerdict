import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import {
  makeAgentSecurityEvent,
  type AgentSecurityEventIdAdapter,
} from "./agent-security-event.js";
import type { AccountAgentIdAdapter } from "./account-agent-surface.js";
import {
  AgentAlreadyOwnedError,
  getAccountById,
  getAccountByPrivyUserId,
  linkAgentToAccount,
} from "./auth/accounts.js";
import { agentSecurityEventsRepo } from "./repos/agent-security-events-repo.js";
import { agentsRepo } from "./repos/agents-repo.js";
import {
  AgentProfileSchema,
  AgentSlugSchema,
} from "./schema.js";
import { nowIso } from "./time.js";

export type AdminClaimErrorCode =
  | "invalid_input"
  | "account_not_found"
  | "agent_already_owned_by_another_account";

export class AdminClaimError extends Error {
  readonly code: AdminClaimErrorCode;
  readonly exitCode: 2 | 3 | 4;

  constructor(code: AdminClaimErrorCode, message: string, exitCode: 2 | 3 | 4) {
    super(message);
    this.name = "AdminClaimError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface AdminClaimInput {
  db: Database.Database;
  account: string;
  slug: string;
  displayName?: string;
  bio?: string;
  newAgentId?: AccountAgentIdAdapter;
  newAgentSecurityEventId?: AgentSecurityEventIdAdapter;
  now: () => Date;
}

export interface AdminClaimResult {
  ok: true;
  event_id: string;
  agent_id: string;
  account_id: string;
  slug: string;
  created_agent: boolean;
}

const AdminClaimBodySchema = z.object({
  slug: AgentSlugSchema,
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(280).optional(),
}).strict();

export function adminClaimAgent(input: AdminClaimInput): AdminClaimResult {
  const parsed = AdminClaimBodySchema.safeParse({
    slug: input.slug,
    displayName: input.displayName,
    bio: input.bio,
  });
  if (!parsed.success) {
    throw invalidInput(parsed.error);
  }

  const { slug } = parsed.data;
  const displayName = parsed.data.displayName ?? slug;
  const accountId = resolveAdminClaimAccount(input.db, input.account);

  let agentId = "";
  let createdAgent = false;
  let eventId = "";
  try {
    input.db.transaction(() => {
      const claimedAt = input.now();
      const claimedAtIso = nowIso(claimedAt);
      const existing = agentsRepo.bySlug(input.db, slug);
      if (existing) {
        agentId = existing.agent_id;
      } else {
        agentId = (input.newAgentId ?? randomUUID)();
        const profile = AgentProfileSchema.parse({
          agent_id: agentId,
          display_slug: slug,
          kind: "agent",
          display_name: displayName,
          ...(parsed.data.bio !== undefined ? { bio: parsed.data.bio } : {}),
          created_at: claimedAtIso,
        });
        agentsRepo.insert(input.db, profile);
        createdAgent = true;
      }

      linkAgentToAccount(input.db, accountId, agentId, { linkedAt: claimedAt });
      const event = makeAgentSecurityEvent({
        agent_id: agentId,
        account_id: accountId,
        kind: "admin_claim",
        actor: "cli:admin-claim",
        newEventId: input.newAgentSecurityEventId,
        payload: {
          slug,
          created_agent: createdAgent,
          display_name: parsed.data.displayName ?? null,
        },
        createdAt: claimedAt,
      });
      eventId = event.event_id;
      agentSecurityEventsRepo.emit(input.db, event);
    })();
  } catch (err) {
    if (err instanceof AgentAlreadyOwnedError) {
      throw new AdminClaimError(
        "agent_already_owned_by_another_account",
        `agent ${err.agent_id} is already linked to a different account. Use --unlink first (not implemented in Wave 5).`,
        4,
      );
    }
    if (err instanceof ZodError) {
      throw invalidInput(err);
    }
    throw err;
  }

  return {
    ok: true,
    event_id: eventId,
    agent_id: agentId,
    account_id: accountId,
    slug,
    created_agent: createdAgent,
  };
}

function resolveAdminClaimAccount(
  db: Database.Database,
  accountRef: string,
): string {
  if (accountRef.startsWith("privy:")) {
    const did = accountRef.slice("privy:".length);
    const account = getAccountByPrivyUserId(db, did);
    if (!account) {
      throw new AdminClaimError(
        "account_not_found",
        `no account row for privy_user_id='${did}'. The owner must log in via Privy at least once first.`,
        3,
      );
    }
    return account.account_id;
  }

  const account = getAccountById(db, accountRef);
  if (!account) {
    throw new AdminClaimError(
      "account_not_found",
      `no account row for account_id='${accountRef}'`,
      3,
    );
  }
  return account.account_id;
}

function invalidInput(err: ZodError): AdminClaimError {
  return new AdminClaimError(
    "invalid_input",
    `invalid input - ${err.message}`,
    2,
  );
}
