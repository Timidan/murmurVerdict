import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import type { CallStatus } from "../schema.js";

export interface SealedFhenixAcceptanceInput {
  call_id: string;
  agent_id: string;
  runtime_key_id?: string | null;
  client_order_id: string;
  horizon_seconds: number;
  submitted_at: string;
  accepted_at: string;
  rationale?: string | null;
  strategy_tag?: string | null;
  schema_version: number;
  scoring_version: number;
  dedup_key: string;
  commit_hash: string;
  commit_scheme: string;
  market_id: string;
  market_config_version: number;
  adapter_id: string | null;
  market_family: string | null;
}

export interface ResolverSubmissionContext {
  call_id: string;
  agent_id: string;
  horizon_seconds: number;
  accepted_at: string;
  status: CallStatus;
  privacy_mode: string | null;
  commit_hash: string | null;
  commitment_json: string | null;
  market_id: string | null;
  market_config_version: number | null;
  adapter_id: string | null;
  market_family: string | null;
}

export const submissionsRepo = {
  acceptSealedFhenixCall(
    db: Database.Database,
    input: SealedFhenixAcceptanceInput,
  ): void {
    prep(
      db,
      `INSERT INTO submissions
       (call_id, agent_id, runtime_key_id, client_order_id,
        horizon_seconds,
        submitted_at, accepted_at, status, rationale, strategy_tag,
       schema_version, scoring_version, dedup_key,
       privacy_mode, commit_hash, commit_scheme,
       market_id, market_config_version,
       adapter_id, market_family,
        commitment_json, predicted_outcome_json, outcome_labels_json)
       VALUES (@call_id, @agent_id, @runtime_key_id, @client_order_id,
        @horizon_seconds,
        @submitted_at, @accepted_at, 'accepted', @rationale, @strategy_tag,
        @schema_version, @scoring_version, @dedup_key,
        'sealed_fhenix', @commit_hash, @commit_scheme,
        @market_id, @market_config_version,
        @adapter_id, @market_family,
        NULL, NULL, NULL)`,
    ).run({
      ...input,
      runtime_key_id: input.runtime_key_id ?? null,
      rationale: input.rationale ?? null,
      strategy_tag: input.strategy_tag ?? null,
      adapter_id: input.adapter_id ?? null,
      market_family: input.market_family ?? null,
    });
  },

  attachRevealedCommitment(
    db: Database.Database,
    input: {
      call_id: string;
      commitment_json: string;
      predicted_outcome_json: string;
      outcome_labels_json: string;
    },
  ): void {
    const result = prep(
      db,
      `UPDATE submissions
       SET commitment_json = @commitment_json,
           predicted_outcome_json = @predicted_outcome_json,
           outcome_labels_json = @outcome_labels_json
       WHERE call_id = @call_id
         AND privacy_mode = 'sealed_fhenix'`,
    ).run(input);
    if (result.changes !== 1) {
      throw new Error(`sealed_fhenix commitment attach failed for call_id=${input.call_id}`);
    }
  },

  findByClientOrderId(
    db: Database.Database,
    agent_id: string,
    client_order_id: string,
  ): { call_id: string } | null {
    const row = prep(
      db,
      "SELECT call_id FROM submissions WHERE agent_id = ? AND client_order_id = ?",
    ).get(agent_id, client_order_id) as { call_id: string } | undefined;
    return row ?? null;
  },

  findByDedupKey(
    db: Database.Database,
    dedup_key: string,
  ): { call_id: string } | null {
    const row = prep(
      db,
      "SELECT call_id FROM submissions WHERE dedup_key = ?",
    ).get(dedup_key) as { call_id: string } | undefined;
    return row ?? null;
  },

  countCallsForAgentMarketWindow(
    db: Database.Database,
    agent_id: string,
    market_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND market_id = ? AND accepted_at >= ?`,
    ).get(agent_id, market_id, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  countCallsForRuntimeKeyWindow(
    db: Database.Database,
    runtime_key_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE runtime_key_id = ? AND accepted_at >= ?`,
    ).get(runtime_key_id, sinceIso) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  setStatus(
    db: Database.Database,
    call_id: string,
    status: CallStatus,
  ): void {
    prep(
      db,
      "UPDATE submissions SET status = ? WHERE call_id = ?",
    ).run(status, call_id);
  },

  /**
   * Atomically move a submission only when its current status is one of the
   * expected source states. Async workers must use this after awaiting remote
   * I/O so a terminal writer cannot be overwritten from a stale context.
   */
  transitionStatus(
    db: Database.Database,
    call_id: string,
    from: readonly CallStatus[],
    to: CallStatus,
  ): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const result = prep(
      db,
      `UPDATE submissions
       SET status = ?
       WHERE call_id = ?
         AND status IN (${placeholders})`,
    ).run(to, call_id, ...from);
    return result.changes === 1;
  },

  listPending(
    db: Database.Database,
    status: Extract<CallStatus, "accepted" | "pending_t0" | "pending_t1">,
  ): Array<{
    call_id: string;
    agent_id: string;
    horizon_seconds: number;
    accepted_at: string;
  }> {
    return prep(
      db,
      `SELECT call_id, agent_id, horizon_seconds, accepted_at
       FROM submissions
       WHERE status = ?
       ORDER BY accepted_at`,
    ).all(status) as Array<{
      call_id: string;
      agent_id: string;
      horizon_seconds: number;
      accepted_at: string;
    }>;
  },

  loadResolverContext(
    db: Database.Database,
    call_id: string,
  ): ResolverSubmissionContext | null {
    return (
      (prep(
        db,
        `SELECT call_id, agent_id, horizon_seconds,
                accepted_at, status, privacy_mode, commit_hash,
                commitment_json,
                market_id, market_config_version,
                adapter_id, market_family
         FROM submissions
         WHERE call_id = ?`,
      ).get(call_id) as ResolverSubmissionContext | undefined) ?? null
    );
  },
};
