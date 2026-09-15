// ─── Owner-facing lifecycle: profile, retirement, account closure ──────────
//
//   PATCH /v1/account/agents/:slug/profile   { display_name?, bio? }
//   POST  /v1/account/agents/:slug/retire
//   POST  /v1/account/agents/:slug/unretire
//   POST  /v1/account/agents/:slug/delete    { confirm: slug }
//   POST  /v1/account/deactivate             { confirm }
//
// Every route here is Privy-authed and, for the agent-scoped ones, gated by
// requireOwnedAgentBySlug — the same ownership check provider-terms and
// earnings use, which 404s on an agent this account does not own rather than
// distinguishing "missing" from "not yours".

import { z } from "zod";
import type Database from "better-sqlite3";

import { assertAgentOwnedBy, requireOwnedAgentBySlug } from "./agent-identity.js";
import {
  accountDeactivatedAt,
  deactivateAccount,
  retireAgent,
  unretireAgent,
} from "./auth/account-lifecycle.js";
import { agentsRepo } from "./repos/agents-repo.js";
import { ERROR_CODES, SCHEMA_VERSION, VerdictError } from "./schema.js";

export interface AccountLifecycleResponse {
  status: number;
  body: unknown;
}

/**
 * display_slug is absent from this schema and must stay absent.
 *
 * The slug is the agent's public identity: it is in every dashboard URL, on
 * every share card, in every receipt an early-access subscriber holds, and it
 * is the JOIN KEY the webhooks table uses (webhooks.agent_slug, not agent_id).
 * Meanwhile provider_earnings and provider_payouts key on agent_id. Letting an
 * owner rename the slug would therefore quietly break the first set while the
 * second kept working — the worst kind of half-broken. Renaming is a create +
 * retire, which is honest about what it costs.
 */
const ProfilePatchSchema = z
  .object({
    // Same bounds the create surface enforces, so an agent cannot be edited
    // into a shape it could not have been created in.
    display_name: z.string().trim().min(1).max(120).optional(),
    // `null` CLEARS the bio; omitted leaves it alone. The two are different
    // intents and the wire has to be able to say both.
    bio: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export function updateAccountAgentProfile(deps: {
  db: Database.Database;
  accountId: string;
  slug: string;
  body: unknown;
}): AccountLifecycleResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const parsed = ProfilePatchSchema.safeParse(deps.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "invalid profile",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.issues },
    );
  }
  const fields = parsed.data;
  if (fields.display_name === undefined && fields.bio === undefined) {
    throw new VerdictError(
      "send display_name, bio, or both",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  agentsRepo.updateProfile(deps.db, agent.agent_id, {
    ...(fields.display_name !== undefined ? { display_name: fields.display_name } : {}),
    // An empty string after trimming means the same thing as null here: the
    // owner cleared the field.
    ...(fields.bio !== undefined ? { bio: fields.bio === "" ? null : fields.bio } : {}),
  });
  const updated = agentsRepo.byId(deps.db, agent.agent_id);
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      agent: {
        agent_id: agent.agent_id,
        // Echoed so the client can see it did NOT change.
        display_slug: agent.display_slug,
        display_name: updated?.display_name ?? agent.display_name,
        bio: updated?.bio ?? null,
        retired_at: updated?.retired_at ?? null,
      },
      slug_immutable: true,
    },
  };
}

export function retireAccountAgent(deps: {
  db: Database.Database;
  accountId: string;
  slug: string;
  now: () => Date;
}): AccountLifecycleResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const result = retireAgent(deps.db, { agent_id: agent.agent_id, now: deps.now });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      agent_slug: agent.display_slug,
      retired: true,
      already_retired: result.already,
      retired_at: result.retired_at,
      // Said in the response, not only in the UI, because an API caller
      // deserves to know what did and did not just happen.
      effect:
        "This agent takes no new calls. Calls already queued finish. Its record, " +
        "its history, and its earnings stay exactly as they are.",
    },
  };
}

export function unretireAccountAgent(deps: {
  db: Database.Database;
  accountId: string;
  slug: string;
  now: () => Date;
}): AccountLifecycleResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const result = unretireAgent(deps.db, { agent_id: agent.agent_id, now: deps.now });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      agent_slug: agent.display_slug,
      retired: false,
      already_active: result.already,
      retired_at: null,
    },
  };
}

/** Keep ownership and historical rows for receipts/payouts; remove agent access. */
export function deleteAccountAgent(deps: {
  db: Database.Database;
  accountId: string;
  slug: string;
  body: unknown;
  now: () => Date;
}): AccountLifecycleResponse {
  return deps.db.transaction(() => {
    // Resolve ownership even after deletion so a lost response can be retried.
    const agent = agentsRepo.bySlug(deps.db, deps.slug);
    if (!agent) throw new VerdictError("unknown agent", ERROR_CODES.unknown_agent, 404);
    assertAgentOwnedBy(deps.db, deps.accountId, agent.agent_id);
    const parsed = z.object({ confirm: z.literal(agent.display_slug) }).strict().safeParse(deps.body);
    if (!parsed.success) {
      throw new VerdictError("type the agent handle to confirm permanent deletion", ERROR_CODES.schema_invalid, 400);
    }
    const timestamp = deps.now().toISOString();
    deps.db.prepare(`UPDATE agents
      SET deleted_at = COALESCE(deleted_at, ?), retired_at = COALESCE(retired_at, ?), api_key_hash = NULL
      WHERE agent_id = ?`).run(timestamp, timestamp, agent.agent_id);
    deps.db.prepare(`UPDATE agent_runtime_keys SET revoked_at = ?, revoke_reason = 'agent_deleted'
      WHERE agent_id = ? AND revoked_at IS NULL`).run(timestamp, agent.agent_id);
    deps.db.prepare(`UPDATE api_keys SET rotated_at = ?
      WHERE agent_id = ? AND rotated_at IS NULL`).run(timestamp, agent.agent_id);
    return {
      status: 200,
      body: {
        schema_version: SCHEMA_VERSION,
        agent_slug: agent.display_slug,
        deleted: true,
        deleted_at: agentsRepo.deletedAt(deps.db, agent.agent_id),
      },
    };
  }).immediate();
}

/**
 * The phrase the caller must send. A closed account cannot be reopened from
 * the API at all, so the confirmation is not ceremony for its own sake — it is
 * the last point at which the decision is still the caller's.
 */
export const ACCOUNT_DEACTIVATE_CONFIRM = "close-my-account";

export function deactivateAccountSurface(deps: {
  db: Database.Database;
  accountId: string;
  body: unknown;
  now: () => Date;
}): AccountLifecycleResponse {
  const confirm = (deps.body as { confirm?: unknown } | undefined)?.confirm;
  if (confirm !== ACCOUNT_DEACTIVATE_CONFIRM) {
    throw new VerdictError(
      `closing the account requires { "confirm": "${ACCOUNT_DEACTIVATE_CONFIRM}" }`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  const result = deactivateAccount(deps.db, {
    account_id: deps.accountId,
    actor: `privy:${deps.accountId}`,
    now: deps.now,
  });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      deactivated: true,
      already_deactivated: result.already_deactivated,
      deactivated_at: result.deactivated_at,
      runtime_keys_revoked: result.runtime_keys_revoked,
      api_keys_rotated: result.api_keys_rotated,
      agents_retired: result.agents_retired,
      reactivation:
        "There is no way to reopen this account from here. Ask the operator.",
    },
  };
}

/** Read the terminal state so a session response can render it. */
export function accountDeactivationState(
  db: Database.Database,
  accountId: string,
): { deactivated: boolean; deactivated_at: string | null } {
  const at = accountDeactivatedAt(db, accountId);
  return { deactivated: at !== null, deactivated_at: at };
}
