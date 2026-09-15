// ─── The payout journal ─────────────────────────────────────────────────────
//
//   POST /v1/admin/payouts                        (operator, admin token)
//   GET  /v1/account/agents/:slug/payouts         (owner, Privy)
//
// Payouts are manual (the rail settles to one seller address); this journal records them.
// Idempotent on (agent, currency, tx_ref): same content replays, different content is a 409.
// Append-only; correct a mistake with a 'reversal'.

import type Database from "better-sqlite3";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import { agentsRepo } from "./repos/agents-repo.js";
import {
  providerPayoutsRepo,
  type ProviderPayoutEntryType,
  type ProviderPayoutInsert,
  type ProviderPayoutRow,
} from "./repos/provider-payouts-repo.js";
import { ERROR_CODES, SCHEMA_VERSION, VerdictError } from "./schema.js";
import { nowIso } from "./time.js";

export interface ProviderPayoutResponse {
  status: number;
  body: unknown;
}

export interface RecordProviderPayoutDeps {
  db: Database.Database;
  body: unknown;
  now: () => Date;
}

const MAX_REF_LEN = 200;
const MAX_NOTE_LEN = 500;
const AMOUNT_ATOMS_RE = /^[1-9][0-9]*$/;
const CURRENCY_RE = /^[A-Z0-9]{2,16}$/;

/**
 * Operator records one movement of money to a provider.
 *
 * 201 — a new journal entry landed.
 * 200 — this exact entry was already recorded (retry-safe replay).
 * 409 — the key was already used for DIFFERENT content.
 */
export function recordProviderPayout(
  deps: RecordProviderPayoutDeps,
): ProviderPayoutResponse {
  const body = asObject(deps.body);
  const slug = requiredString(body.agent_slug, "agent_slug", 200);
  const agent = agentsRepo.bySlug(deps.db, slug);
  if (!agent) {
    throw new VerdictError("unknown agent", ERROR_CODES.unknown_agent, 404);
  }

  const entryType = parseEntryType(body.entry_type);
  const currency = requiredString(body.currency, "currency", 16).toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    throw new VerdictError(
      "currency must be 2-16 letters or digits, for example USDC",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  const amountAtoms = requiredString(body.amount_atoms, "amount_atoms", 80);
  if (!AMOUNT_ATOMS_RE.test(amountAtoms)) {
    // Same rule as the column CHECK: positive integer, no leading zero.
    throw new VerdictError(
      "amount_atoms must be a positive whole number of atomic units, with no leading zero",
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  const txRef = requiredString(body.tx_ref, "tx_ref", MAX_REF_LEN);
  const payoutMethod = requiredString(body.payout_method, "payout_method", MAX_REF_LEN);
  const destinationRef = requiredString(body.destination_ref, "destination_ref", MAX_REF_LEN);
  const note = optionalString(body.note, "note", MAX_NOTE_LEN);

  const createdAt = nowIso(deps.now());
  const earningsCutoffAt = canonicalIso(body.earnings_cutoff_at, "earnings_cutoff_at");
  if (earningsCutoffAt > createdAt) {
    throw new VerdictError(
      "earnings_cutoff_at cannot be in the future",
      ERROR_CODES.schema_invalid,
      400,
      { earnings_cutoff_at: earningsCutoffAt, created_at: createdAt },
    );
  }

  const insert: ProviderPayoutInsert = {
    producer_agent_id: agent.agent_id,
    entry_type: entryType,
    currency,
    amount_atoms: amountAtoms,
    tx_ref: txRef,
    payout_method: payoutMethod,
    destination_ref: destinationRef,
    note,
    earnings_cutoff_at: earningsCutoffAt,
    created_at: createdAt,
  };

  // Existence check inside the transaction so concurrent retries don't hit the UNIQUE index as a 500.
  let outcome: { status: 200 | 201; row: ProviderPayoutRow } | null = null;
  let conflict: ProviderPayoutRow | null = null;
  let overReversalMax: string | null = null;
  deps.db.transaction(() => {
    const existing = providerPayoutsRepo.byIdempotencyKey(deps.db, {
      producerAgentId: agent.agent_id,
      currency,
      txRef,
    });
    if (existing) {
      if (sameEntry(existing, insert)) {
        outcome = { status: 200, row: existing };
        return;
      }
      conflict = existing;
      return;
    }
    // A reversal can't exceed net paid, or a typo would report fictitious debt. In-transaction so
    // two concurrent reversals can't both pass.
    if (entryType === "reversal") {
      const netPaid = providerPayoutsRepo.netPaidAtoms(deps.db, {
        producerAgentId: agent.agent_id,
        currency,
      });
      if (BigInt(amountAtoms) > netPaid) {
        overReversalMax = netPaid.toString();
        return;
      }
    }
    outcome = { status: 201, row: providerPayoutsRepo.insert(deps.db, insert) };
  }).immediate();

  if (overReversalMax !== null) {
    throw new VerdictError(
      `reversal exceeds what the journal has paid for this agent and currency. ` +
        `The maximum reversible amount is ${overReversalMax} atoms.`,
      ERROR_CODES.schema_invalid,
      422,
      { max_reversible_atoms: overReversalMax },
    );
  }

  if (conflict) {
    throw new VerdictError(
      "this payout reference is already recorded for this agent and currency with different details. " +
        "The journal is append-only: post a reversal instead of re-posting the payout.",
      ERROR_CODES.duplicate,
      409,
      { existing: publicPayoutRow(conflict, agent.display_slug) },
    );
  }
  if (!outcome) throw new Error("payout journal transaction produced no result");
  const settled = outcome as { status: 200 | 201; row: ProviderPayoutRow };
  return {
    status: settled.status,
    body: {
      schema_version: SCHEMA_VERSION,
      recorded: settled.status === 201,
      payout: publicPayoutRow(settled.row, agent.display_slug),
    },
  };
}

export interface ReadProviderPayoutsDeps {
  db: Database.Database;
  accountId: string;
  slug: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The owner's own view of what murmur has paid them. Newest first. */
export function readProviderPayouts(
  deps: ReadProviderPayoutsDeps,
): ProviderPayoutResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const limit = clamp(deps.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, Math.floor(deps.offset ?? 0));
  const rows = providerPayoutsRepo.listForAgent(deps.db, {
    producerAgentId: agent.agent_id,
    limit,
    offset,
  });
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      agent_slug: agent.display_slug,
      payouts: rows.map((row) => publicPayoutRow(row, agent.display_slug)),
      totals: providerPayoutsRepo.totalsForAgent(deps.db, agent.agent_id),
      page: { limit, offset, returned: rows.length },
    },
  };
}

export function publicPayoutRow(row: ProviderPayoutRow, agentSlug: string) {
  return {
    id: row.id,
    agent_slug: agentSlug,
    entry_type: row.entry_type,
    currency: row.currency,
    amount_atoms: row.amount_atoms,
    tx_ref: row.tx_ref,
    payout_method: row.payout_method,
    destination_ref: row.destination_ref,
    note: row.note,
    earnings_cutoff_at: row.earnings_cutoff_at,
    created_at: row.created_at,
  };
}

/** Content equality for replay; created_at is excluded because a retry arrives later. */
function sameEntry(existing: ProviderPayoutRow, incoming: ProviderPayoutInsert): boolean {
  return (
    existing.producer_agent_id === incoming.producer_agent_id &&
    existing.entry_type === incoming.entry_type &&
    existing.currency === incoming.currency.toUpperCase() &&
    existing.amount_atoms === incoming.amount_atoms &&
    existing.tx_ref === incoming.tx_ref &&
    existing.payout_method === incoming.payout_method &&
    existing.destination_ref === incoming.destination_ref &&
    (existing.note ?? null) === (incoming.note ?? null) &&
    existing.earnings_cutoff_at === incoming.earnings_cutoff_at
  );
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VerdictError("body must be a JSON object", ERROR_CODES.schema_invalid, 400);
  }
  return raw as Record<string, unknown>;
}

function requiredString(raw: unknown, field: string, max: number): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new VerdictError(`${field} is required`, ERROR_CODES.schema_invalid, 400);
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    throw new VerdictError(
      `${field} must be ${max} characters or fewer`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return trimmed;
}

function optionalString(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new VerdictError(`${field} must be a string`, ERROR_CODES.schema_invalid, 400);
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new VerdictError(
      `${field} must be ${max} characters or fewer`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return trimmed;
}

function parseEntryType(raw: unknown): ProviderPayoutEntryType {
  if (raw === "payout" || raw === "reversal") return raw;
  throw new VerdictError(
    "entry_type must be 'payout' or 'reversal'",
    ERROR_CODES.schema_invalid,
    400,
  );
}

/** Canonical second-precision ISO; stored strings are compared lexically against created_at. */
function canonicalIso(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new VerdictError(`${field} is required`, ERROR_CODES.schema_invalid, 400);
  }
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) {
    throw new VerdictError(
      `${field} must be an ISO timestamp`,
      ERROR_CODES.schema_invalid,
      400,
    );
  }
  return nowIso(new Date(ms));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
