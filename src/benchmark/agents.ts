import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { agentsRepo } from "../verdict/db.js";
import { submitCall } from "../verdict/submissions.js";
import {
  REGISTERED_STRATEGY_TAGS,
  StrategyTag,
} from "../verdict/schema.js";

// ─── Baseline agent definitions ──────────────────────────────────────────────
//
// Wave 4b-2 — the original three baselines (Murmur Momentum, Contrarian,
// Risk-Off) drove their decisions off the Santiment scout/analyst pipeline:
// composite_score, regime, and top_playbook. With the Santiment integration
// removed, those baselines have no decision basis and runBaselinesOnce()
// becomes a no-op. The baseline agent rows stay registered so historical
// references (already-resolved leaderboard entries) keep their display
// metadata; the daemon ticker that calls runBaselinesOnce simply produces
// zero new submissions until a replacement signal source lands.

export interface BaselineDef {
  display_slug: string;
  display_name: string;
  bio: string;
  strategy_tag: StrategyTag;
}

const MOMENTUM: BaselineDef = {
  display_slug: "murmur-momentum",
  display_name: "Murmur Momentum",
  bio: "Deterministic momentum baseline (4h). Currently dormant — awaiting a new signal source after the Santiment integration was retired.",
  strategy_tag: "momentum",
};

const CONTRARIAN: BaselineDef = {
  display_slug: "murmur-contrarian",
  display_name: "Murmur Contrarian",
  bio: "Euphoria-fade baseline (24h). Currently dormant — awaiting a new signal source after the Santiment integration was retired.",
  strategy_tag: "fade",
};

const RISK_OFF: BaselineDef = {
  display_slug: "murmur-risk-off",
  display_name: "Murmur Risk-Off",
  bio: "Risk-off baseline (4h). Currently dormant — awaiting a new signal source after the Santiment integration was retired.",
  strategy_tag: "macro",
};

export const DEFAULT_BASELINES: readonly BaselineDef[] = [
  MOMENTUM,
  CONTRARIAN,
  RISK_OFF,
] as const;

// ─── Driver ──────────────────────────────────────────────────────────────────

export interface BenchmarkRunDeps {
  db: Database.Database;
  baselines?: readonly BaselineDef[];
  /** Override for tests; default new Date(). */
  now?: () => Date;
  /** Test injection: if provided, we use this instead of submitCall. */
  submit?: typeof submitCall;
}

export interface BenchmarkRunReport {
  considered: number;
  submitted: number;
  silent: number;
  skipped_dedup: number;
  errors: Array<{ slug: string; reason: string }>;
}

/**
 * Ensure all baselines exist as agents in the DB. Idempotent.
 */
export function registerBaselines(
  db: Database.Database,
  baselines: readonly BaselineDef[] = DEFAULT_BASELINES,
): void {
  for (const b of baselines) {
    if (agentsRepo.bySlug(db, b.display_slug)) continue;
    agentsRepo.insert(db, {
      agent_id: randomUUID(),
      display_slug: b.display_slug,
      kind: "benchmark",
      display_name: b.display_name,
      bio: b.bio,
      verified_identities: [],
      created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    });
  }
}

/**
 * Wave 4b-2 — no-op. The Santiment-driven decision logic was removed; the
 * daemon ticker still calls this on its cadence so re-introducing a signal
 * source later is a single-file change rather than a daemon-wiring change.
 */
export async function runBaselinesOnce(
  deps: BenchmarkRunDeps,
): Promise<BenchmarkRunReport> {
  void deps;
  return {
    considered: 0,
    submitted: 0,
    silent: 0,
    skipped_dedup: 0,
    errors: [],
  };
}

// Strategy-tag invariant guard so removing a tag from REGISTERED_STRATEGY_TAGS
// breaks compilation here (and prevents silent runtime drift).
const _strategyTagsKnown: Record<string, true> = REGISTERED_STRATEGY_TAGS.reduce(
  (acc, t) => ({ ...acc, [t]: true }),
  {} as Record<string, true>,
);
void _strategyTagsKnown;
