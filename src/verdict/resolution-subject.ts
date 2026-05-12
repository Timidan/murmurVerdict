import type Database from "better-sqlite3";

/**
 * Wave 3b — legacy resolution-subject loader stubbed out.
 *
 * The original module hydrated plaintext (side / asset_id / horizon_hours /
 * confidence) for legacy_plaintext and committed-mode calls from a
 * call_reveals row (with daemon age-decrypt and drand fallback paths).
 * Waves 2a/2b deleted those submit modes and MIGRATION_031 dropped the
 * underlying tables (call_reveals + call_private_envelopes) plus the
 * plaintext columns on submissions. There is no path that hydrates a
 * non-FHE prediction anymore.
 *
 * The exported type + entry point survive only to keep the existing
 * smoke-test imports from breaking the build. Every call returns
 * `call_not_found` — the resolver's caller now skips non-FHE rows
 * before this would be reached.
 *
 * Removing this module entirely is a follow-up cleanup once the smoke
 * test is rewritten (Wave 4a / Wave 5).
 */

export type ResolutionSubjectSource =
  | "agent"
  | "daemon_fallback"
  | "drand_fallback"
  | "legacy_plaintext"
  | "fhevm_compute";

export interface ResolutionSubject {
  call_id: string;
  source: ResolutionSubjectSource;
  side: "BUY" | "SELL";
  asset_id: string;
  horizon_hours: number;
  confidence: number;
  rationale: string | null;
  strategy_tag: string | null;
  agent_wallet: string | null;
  chain_id: string | null;
  commit_preimage_hash: string | null;
  commit_preimage_schema: string | null;
  revealed_at: string;
  reveal_hash_valid: boolean;
  market_id: string | null;
  market_config_version: number | null;
  horizon_seconds: number | null;
  scoring_kind: string | null;
  void_band: string | null;
}

export type SubjectResult =
  | { ok: true; subject: ResolutionSubject }
  | {
      ok: false;
      reason:
        | "not_yet_revealable"
        | "envelope_missing"
        | "decrypt_failed"
        | "hash_mismatch"
        | "call_not_found";
      detail?: string;
    };

export async function loadResolutionSubject(
  _db: Database.Database,
  _call_id: string,
  _opts: { now?: () => Date } = {},
): Promise<SubjectResult> {
  return {
    ok: false,
    reason: "call_not_found",
    detail:
      "Wave 3b — non-FHE resolution paths are no longer supported; the resolver short-circuits before this is reached.",
  };
}
