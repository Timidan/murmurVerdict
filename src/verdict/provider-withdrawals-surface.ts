// ─── The owner's withdrawal surface ─────────────────────────────────────────
//
// Ownership-gated like every other agent-scoped read: an agent's money is
// nobody else's business. The POST is the only route in murmur that can cause
// money to leave, and it deliberately does not move any itself — it takes a
// reservation, and the worker does the rest. So a request that succeeds here
// means "this is owed and now spoken for", never "it has been sent".

import type Database from "better-sqlite3";

import { requireOwnedAgentBySlug } from "./agent-identity.js";
import {
  listWithdrawals,
  requestWithdrawal,
  type PayoutAssetConfig,
} from "./provider-withdrawals.js";
import { readProviderReleaseBalances } from "./provider-release-balance.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface WithdrawalSurfaceDeps {
  db: Database.Database;
  accountId: string;
  slug: string;
  now: () => Date;
  /** null when this deployment runs no payout rail. */
  asset: PayoutAssetConfig | null;
}

export interface SurfaceResponse {
  status: number;
  body: unknown;
}

/** Balances plus recent withdrawals — everything the earnings page needs. */
export function readWithdrawals(deps: WithdrawalSurfaceDeps): SurfaceResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  const balances = readProviderReleaseBalances(deps.db, agent.agent_id);
  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      // Says plainly whether a withdraw control should exist at all, so the
      // dashboard never offers a button this deployment cannot honour.
      withdrawals_available: deps.asset !== null,
      payout_asset: deps.asset
        ? {
            chain_id: deps.asset.chainId,
            token_address: deps.asset.tokenAddress,
            currency: deps.asset.currency,
          }
        : null,
      balances,
      withdrawals: listWithdrawals(deps.db, agent.agent_id).map(publicWithdrawal),
    },
  };
}

export function createWithdrawal(
  deps: WithdrawalSurfaceDeps,
  body: unknown,
): SurfaceResponse {
  const agent = requireOwnedAgentBySlug(deps.db, deps.accountId, deps.slug);
  if (!deps.asset) {
    return {
      status: 503,
      body: {
        error: "payouts are not enabled on this deployment",
        code: "payouts_disabled",
      },
    };
  }
  const input = (body ?? {}) as { client_request_id?: unknown; amount_atoms?: unknown };
  const clientRequestId = String(input.client_request_id ?? "").trim();
  if (!clientRequestId) {
    return {
      status: 400,
      body: {
        error: "client_request_id is required — it is what makes a retry safe",
        code: "bad_request",
      },
    };
  }
  const amountAtoms =
    input.amount_atoms === undefined || input.amount_atoms === null
      ? null
      : String(input.amount_atoms);

  const out = requestWithdrawal(
    { db: deps.db, now: deps.now, asset: deps.asset },
    { producerAgentId: agent.agent_id, clientRequestId, amountAtoms },
  );
  if (!out.ok) {
    return { status: out.status, body: { error: out.message, code: out.code } };
  }
  return {
    // 200 on a replay, 201 on a fresh reservation: a client that retried
    // through a timeout gets the same row and can tell that it did.
    status: out.replayed ? 200 : 201,
    body: {
      schema_version: SCHEMA_VERSION,
      replayed: out.replayed,
      withdrawal: publicWithdrawal(out.withdrawal),
    },
  };
}

/**
 * What the owner sees. The signed bytes are deliberately NOT included: they
 * are an internal recovery artifact, and publishing a raw signed transaction
 * invites somebody to broadcast it out of band.
 */
function publicWithdrawal(row: {
  id: number;
  client_request_id: string;
  chain_id: number;
  currency: string;
  amount_atoms: string;
  destination_address: string;
  state: string;
  tx_hash: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    client_request_id: row.client_request_id,
    chain_id: row.chain_id,
    currency: row.currency,
    amount_atoms: row.amount_atoms,
    destination_address: row.destination_address,
    state: row.state,
    tx_hash: row.tx_hash,
    // One sentence an owner can act on, rather than the raw worker error.
    status_note: statusNote(row.state),
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function statusNote(state: string): string {
  switch (state) {
    case "reserved":
      return "Queued. Nothing has been sent yet.";
    case "signed":
    case "submitted":
      return "Sent to the network. Waiting for it to confirm.";
    case "paid":
      return "Paid, and recorded in the payouts journal below.";
    case "failed":
      return "The transfer did not go through. The money is back in your available balance.";
    case "needs_review":
      return "Murmur could not confirm what happened on chain, so an operator is checking. The amount stays reserved until they do — it is never sent twice.";
    default:
      return state;
  }
}
