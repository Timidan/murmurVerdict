import Database from "better-sqlite3";
import {
  AcceptedCall,
  AgentKind,
  AgentProfile,
  CallStatus,
  ClaimChallenge,
  Dispute,
  DisputeGrounds,
  DisputeStatus,
  Outcome,
  SubmittedCall,
  SCHEMA_VERSION,
  SCORING_VERSION,
  UsageEvent,
  UsageEventKind,
  VerifiedIdentity,
} from "./schema.js";

// ─── DB bootstrap ────────────────────────────────────────────────────────────
//
// SQLite is file-backed; default path resolved from VERDICT_DB_PATH or
// `./data/verdict.db`. WAL mode is enabled so the resolver and submissions
// API can run in parallel without holding locks.

export interface OpenDbOptions {
  path?: string;
  readonly?: boolean;
}

export function openDb(opts: OpenDbOptions = {}): Database.Database {
  const path = opts.path ?? process.env.VERDICT_DB_PATH ?? "./data/verdict.db";
  const db = new Database(path, { readonly: opts.readonly ?? false });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const get = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .pluck();
  const set = db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );

  const current = (get.get("schema_version") as string | undefined) ?? "0";
  let v = Number(current);

  if (v < 1) {
    db.exec(MIGRATION_001);
    v = 1;
    set.run("schema_version", String(v));
    set.run("verdict_schema_version", String(SCHEMA_VERSION));
    set.run("verdict_scoring_version", String(SCORING_VERSION));
  }

  if (v < 2) {
    db.exec(MIGRATION_002);
    v = 2;
    set.run("schema_version", String(v));
  }
}

// ─── Migration 001 — initial schema ──────────────────────────────────────────

const MIGRATION_001 = `
  CREATE TABLE agents (
    agent_id     TEXT PRIMARY KEY,
    display_slug TEXT UNIQUE NOT NULL COLLATE NOCASE,
    kind         TEXT NOT NULL CHECK (kind IN ('benchmark','shadow','verified','internal_test')),
    display_name TEXT NOT NULL,
    bio          TEXT,
    created_at   TEXT NOT NULL,
    api_key_hash TEXT
  );
  CREATE INDEX idx_agents_kind ON agents(kind);

  CREATE TABLE verified_identities (
    identity_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('x','telegram','wallet','openserv')),
    value        TEXT NOT NULL,
    verified_at  TEXT NOT NULL,
    UNIQUE(kind, value)
  );
  CREATE INDEX idx_verified_identities_agent ON verified_identities(agent_id);

  CREATE TABLE submissions (
    call_id           TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    client_order_id   TEXT NOT NULL,
    asset_id          TEXT NOT NULL,
    side              TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    horizon_hours     INTEGER NOT NULL CHECK (horizon_hours IN (1,4,24,168)),
    confidence        REAL NOT NULL CHECK (confidence >= 0.51 AND confidence <= 0.95),
    submitted_at      TEXT NOT NULL,
    accepted_at       TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('accepted','pending_t0','pending_t1','resolved','disputed','re_resolved','rejected')),
    rationale         TEXT,
    strategy_tag      TEXT,
    schema_version    INTEGER NOT NULL,
    scoring_version   INTEGER NOT NULL,
    dedup_key         TEXT NOT NULL,
    UNIQUE(agent_id, client_order_id),
    UNIQUE(dedup_key)
  );
  CREATE INDEX idx_submissions_agent ON submissions(agent_id);
  CREATE INDEX idx_submissions_status ON submissions(status);
  CREATE INDEX idx_submissions_asset_horizon ON submissions(asset_id, horizon_hours);

  CREATE TABLE preflights (
    call_id                 TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    murmur_score            REAL NOT NULL,
    murmur_playbook         TEXT NOT NULL,
    risk_flags_json         TEXT NOT NULL,
    data_freshness_seconds  INTEGER NOT NULL,
    market_regime           TEXT NOT NULL CHECK (market_regime IN ('bullish','bearish','neutral'))
  );

  CREATE TABLE oracle_policies (
    call_id                       TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    primary_feed                  TEXT NOT NULL,
    fallback_feed                 TEXT NOT NULL,
    primary_max_staleness_sec     INTEGER NOT NULL,
    fallback_max_staleness_sec    INTEGER NOT NULL,
    t0_grace_seconds              INTEGER NOT NULL,
    t0_extended_grace_seconds     INTEGER NOT NULL
  );

  CREATE TABLE t0_anchors (
    call_id  TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    t0       TEXT NOT NULL,
    p0       TEXT NOT NULL,
    feed     TEXT NOT NULL,
    source_id TEXT NOT NULL,
    anchored_at TEXT NOT NULL
  );

  CREATE TABLE t1_resolutions (
    call_id        TEXT PRIMARY KEY REFERENCES submissions(call_id) ON DELETE CASCADE,
    t1             TEXT NOT NULL,
    p1             TEXT NOT NULL,
    t1_feed        TEXT NOT NULL,
    signed_return  TEXT NOT NULL,
    outcome        TEXT NOT NULL CHECK (outcome IN ('win','loss','void','oracle_unavailable')),
    call_score     REAL,
    resolved_at    TEXT NOT NULL
  );

  CREATE TABLE receipts (
    receipt_hash    TEXT PRIMARY KEY,
    call_id         TEXT NOT NULL REFERENCES submissions(call_id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('acceptance','resolution','re_resolution')),
    canonical_json  TEXT NOT NULL,
    filecoin_cid    TEXT,
    previous_hash   TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX idx_receipts_call_kind ON receipts(call_id, kind);

  CREATE TABLE disputes (
    dispute_id  TEXT PRIMARY KEY,
    target_resolution_receipt_hash TEXT NOT NULL,
    grounds     TEXT NOT NULL CHECK (grounds IN ('stale_feed','wrong_feed_used','wrong_timestamp','calculation_bug','chain_reorg','oracle_revision_after_resolution')),
    notes       TEXT,
    filed_by    TEXT NOT NULL,
    filed_at    TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open','replay_in_progress','upheld','rejected')),
    resolved_at TEXT,
    new_resolution_receipt_hash TEXT
  );
  CREATE INDEX idx_disputes_target ON disputes(target_resolution_receipt_hash);

  CREATE TABLE claim_challenges (
    challenge_id     TEXT PRIMARY KEY,
    agent_id         TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    target_kind      TEXT NOT NULL,
    target_value     TEXT NOT NULL,
    nonce            TEXT NOT NULL,
    challenge_text   TEXT NOT NULL,
    wallet_to_bind   TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending','verified','expired','rejected')),
    created_at       TEXT NOT NULL
  );
  CREATE INDEX idx_claim_challenges_agent ON claim_challenges(agent_id);

  CREATE TABLE usage_events (
    event_id        TEXT PRIMARY KEY,
    agent_id        TEXT REFERENCES agents(agent_id) ON DELETE SET NULL,
    kind            TEXT NOT NULL,
    ts              TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_usage_events_kind_ts ON usage_events(kind, ts);
`;

// ─── Migration 002 — outreach attribution ────────────────────────────────────
//
// Records every share-page click that arrives with a ?ref=<sender> param.
// The (ref, agent_slug) pair is what makes attribution interesting — it lets
// an agent profile surface "discovered by @sender" once a sender's clicks
// converge on the same agent. We do NOT store any IP / fingerprint; the
// counter is per (ref, slug) bucket, monotonically increasing.

const MIGRATION_002 = `
  CREATE TABLE ref_clicks (
    ref          TEXT NOT NULL,
    agent_slug   TEXT,
    total        INTEGER NOT NULL DEFAULT 0,
    first_at     TEXT NOT NULL,
    last_at      TEXT NOT NULL,
    PRIMARY KEY (ref, agent_slug)
  );
  CREATE INDEX idx_ref_clicks_slug ON ref_clicks(agent_slug);
  CREATE INDEX idx_ref_clicks_total ON ref_clicks(total DESC);
`;

// ─── Repositories (typed, narrow) ────────────────────────────────────────────
//
// Each repository exposes the smallest API the rest of the system needs.
// Statements are prepared lazily via the WeakMap per Database instance.

type Stmt = Database.Statement<unknown[]>;
type StmtCache = Map<string, Stmt>;
const stmtCaches = new WeakMap<Database.Database, StmtCache>();

function prep(db: Database.Database, sql: string): Stmt {
  let cache = stmtCaches.get(db);
  if (!cache) {
    cache = new Map();
    stmtCaches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface AgentRow extends AgentProfile {
  api_key_hash: string | null;
}

export const agentsRepo = {
  insert(
    db: Database.Database,
    profile: AgentProfile,
    api_key_hash: string | null = null,
  ): void {
    prep(
      db,
      `INSERT INTO agents (agent_id, display_slug, kind, display_name, bio, created_at, api_key_hash)
       VALUES (@agent_id, @display_slug, @kind, @display_name, @bio, @created_at, @api_key_hash)`,
    ).run({
      agent_id: profile.agent_id,
      display_slug: profile.display_slug,
      kind: profile.kind,
      display_name: profile.display_name,
      bio: profile.bio ?? null,
      created_at: profile.created_at,
      api_key_hash,
    });
    for (const id of profile.verified_identities) {
      verifiedIdentitiesRepo.insert(db, profile.agent_id, id);
    }
  },

  byId(db: Database.Database, agent_id: string): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE agent_id = ?",
    ).get(agent_id) as RawAgentRow | undefined;
    return row ? hydrateAgent(db, row) : null;
  },

  bySlug(db: Database.Database, slug: string): AgentRow | null {
    const row = prep(
      db,
      "SELECT * FROM agents WHERE display_slug = ? COLLATE NOCASE",
    ).get(slug) as RawAgentRow | undefined;
    return row ? hydrateAgent(db, row) : null;
  },

  setKind(db: Database.Database, agent_id: string, kind: AgentKind): void {
    prep(
      db,
      "UPDATE agents SET kind = ? WHERE agent_id = ?",
    ).run(kind, agent_id);
  },

  setApiKeyHash(
    db: Database.Database,
    agent_id: string,
    api_key_hash: string,
  ): void {
    prep(
      db,
      "UPDATE agents SET api_key_hash = ? WHERE agent_id = ?",
    ).run(api_key_hash, agent_id);
  },

  countActiveCallsForAgent(db: Database.Database, agent_id: string): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND status IN ('accepted','pending_t0','pending_t1')`,
    ).get(agent_id) as { n: number } | undefined;
    return row?.n ?? 0;
  },

  listByKind(
    db: Database.Database,
    kind: AgentKind,
    limit = 100,
  ): Array<Pick<AgentRow, "agent_id" | "display_slug" | "display_name" | "kind" | "bio" | "created_at" | "verified_identities">> {
    const rows = prep(
      db,
      `SELECT agent_id, display_slug, display_name, kind, bio, created_at
       FROM agents
       WHERE kind = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(kind, limit) as Array<RawAgentRow>;
    return rows.map((r) => {
      const hyd = hydrateAgent(db, r);
      return {
        agent_id: hyd.agent_id,
        display_slug: hyd.display_slug,
        display_name: hyd.display_name,
        kind: hyd.kind,
        bio: hyd.bio,
        created_at: hyd.created_at,
        verified_identities: hyd.verified_identities,
      };
    });
  },
};

interface RawAgentRow {
  agent_id: string;
  display_slug: string;
  kind: AgentKind;
  display_name: string;
  bio: string | null;
  created_at: string;
  api_key_hash: string | null;
}

function hydrateAgent(db: Database.Database, row: RawAgentRow): AgentRow {
  const ids = verifiedIdentitiesRepo.listForAgent(db, row.agent_id);
  return {
    agent_id: row.agent_id,
    display_slug: row.display_slug,
    kind: row.kind,
    display_name: row.display_name,
    bio: row.bio ?? undefined,
    created_at: row.created_at,
    verified_identities: ids,
    api_key_hash: row.api_key_hash,
  };
}

// ─── Verified identities ─────────────────────────────────────────────────────

export const verifiedIdentitiesRepo = {
  insert(
    db: Database.Database,
    agent_id: string,
    identity: VerifiedIdentity,
  ): void {
    prep(
      db,
      `INSERT INTO verified_identities (agent_id, kind, value, verified_at)
       VALUES (?, ?, ?, ?)`,
    ).run(agent_id, identity.kind, identity.value, identity.verified_at);
  },

  listForAgent(db: Database.Database, agent_id: string): VerifiedIdentity[] {
    const rows = prep(
      db,
      "SELECT kind, value, verified_at FROM verified_identities WHERE agent_id = ? ORDER BY verified_at",
    ).all(agent_id) as VerifiedIdentity[];
    return rows;
  },

  findByExternal(
    db: Database.Database,
    kind: VerifiedIdentity["kind"],
    value: string,
  ): { agent_id: string } | null {
    const row = prep(
      db,
      "SELECT agent_id FROM verified_identities WHERE kind = ? AND value = ?",
    ).get(kind, value) as { agent_id: string } | undefined;
    return row ?? null;
  },
};

// ─── Submissions / Acceptances ───────────────────────────────────────────────

export interface AcceptanceWriteInput {
  submission: SubmittedCall;
  accepted: AcceptedCall;
  receipt: {
    hash: `0x${string}`;
    canonical_json: string;
    filecoin_cid?: string;
  };
  dedup_key: string;
}

export const submissionsRepo = {
  /** Inserts submission + preflight + oracle policy + acceptance receipt atomically. */
  acceptCall(db: Database.Database, input: AcceptanceWriteInput): void {
    const tx = db.transaction((i: AcceptanceWriteInput) => {
      prep(
        db,
        `INSERT INTO submissions
         (call_id, agent_id, client_order_id, asset_id, side, horizon_hours,
          confidence, submitted_at, accepted_at, status, rationale, strategy_tag,
          schema_version, scoring_version, dedup_key)
         VALUES (@call_id, @agent_id, @client_order_id, @asset_id, @side, @horizon_hours,
          @confidence, @submitted_at, @accepted_at, @status, @rationale, @strategy_tag,
          @schema_version, @scoring_version, @dedup_key)`,
      ).run({
        call_id: i.accepted.call_id,
        agent_id: i.accepted.agent_id,
        client_order_id: i.accepted.client_order_id,
        asset_id: i.accepted.asset_id,
        side: i.accepted.side,
        horizon_hours: i.accepted.horizon_hours,
        confidence: i.accepted.confidence,
        submitted_at: i.accepted.submitted_at,
        accepted_at: i.accepted.accepted_at,
        status: "accepted" satisfies CallStatus,
        rationale: i.accepted.rationale ?? null,
        strategy_tag: i.accepted.strategy_tag ?? null,
        schema_version: i.accepted.schema_version,
        scoring_version: i.accepted.scoring_version,
        dedup_key: i.dedup_key,
      });
      prep(
        db,
        `INSERT INTO preflights
         (call_id, murmur_score, murmur_playbook, risk_flags_json, data_freshness_seconds, market_regime)
         VALUES (@call_id, @murmur_score, @murmur_playbook, @risk_flags_json, @data_freshness_seconds, @market_regime)`,
      ).run({
        call_id: i.accepted.call_id,
        murmur_score: i.accepted.preflight.murmur_score,
        murmur_playbook: i.accepted.preflight.murmur_playbook,
        risk_flags_json: JSON.stringify(i.accepted.preflight.risk_flags),
        data_freshness_seconds: i.accepted.preflight.data_freshness_seconds,
        market_regime: i.accepted.preflight.market_regime,
      });
      prep(
        db,
        `INSERT INTO oracle_policies
         (call_id, primary_feed, fallback_feed, primary_max_staleness_sec,
          fallback_max_staleness_sec, t0_grace_seconds, t0_extended_grace_seconds)
         VALUES (@call_id, @primary_feed, @fallback_feed, @primary_max_staleness_sec,
          @fallback_max_staleness_sec, @t0_grace_seconds, @t0_extended_grace_seconds)`,
      ).run({ call_id: i.accepted.call_id, ...i.accepted.oracle_policy });
      prep(
        db,
        `INSERT INTO receipts
         (receipt_hash, call_id, kind, canonical_json, filecoin_cid, previous_hash, created_at)
         VALUES (?, ?, 'acceptance', ?, ?, NULL, ?)`,
      ).run(
        i.receipt.hash,
        i.accepted.call_id,
        i.receipt.canonical_json,
        i.receipt.filecoin_cid ?? null,
        i.accepted.accepted_at,
      );
    });
    tx(input);
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

  countCallsForAgentAssetWindow(
    db: Database.Database,
    agent_id: string,
    asset_id: string,
    sinceIso: string,
  ): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM submissions
       WHERE agent_id = ? AND asset_id = ? AND submitted_at >= ?`,
    ).get(agent_id, asset_id, sinceIso) as { n: number } | undefined;
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

  listPending(
    db: Database.Database,
    status: Extract<CallStatus, "accepted" | "pending_t0" | "pending_t1">,
  ): Array<{
    call_id: string;
    agent_id: string;
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    confidence: number;
    accepted_at: string;
  }> {
    return prep(
      db,
      `SELECT call_id, agent_id, asset_id, side, horizon_hours, confidence, accepted_at
       FROM submissions
       WHERE status = ?
       ORDER BY accepted_at`,
    ).all(status) as Array<{
      call_id: string;
      agent_id: string;
      asset_id: string;
      side: "BUY" | "SELL";
      horizon_hours: number;
      confidence: number;
      accepted_at: string;
    }>;
  },

  /** Hydrated row used by the resolver when working a call. */
  loadResolverContext(
    db: Database.Database,
    call_id: string,
  ): {
    call_id: string;
    agent_id: string;
    asset_id: string;
    side: "BUY" | "SELL";
    horizon_hours: number;
    confidence: number;
    accepted_at: string;
    status: CallStatus;
    acceptance_receipt_hash: string;
    primary_feed: string;
    fallback_feed: string;
    primary_max_staleness_sec: number;
    fallback_max_staleness_sec: number;
    t0_grace_seconds: number;
    t0_extended_grace_seconds: number;
  } | null {
    return (
      (prep(
        db,
        `SELECT s.call_id, s.agent_id, s.asset_id, s.side, s.horizon_hours,
                s.confidence, s.accepted_at, s.status,
                r.receipt_hash AS acceptance_receipt_hash,
                op.primary_feed, op.fallback_feed,
                op.primary_max_staleness_sec, op.fallback_max_staleness_sec,
                op.t0_grace_seconds, op.t0_extended_grace_seconds
         FROM submissions s
         JOIN oracle_policies op ON op.call_id = s.call_id
         JOIN receipts r ON r.call_id = s.call_id AND r.kind = 'acceptance'
         WHERE s.call_id = ?`,
      ).get(call_id) as
        | {
            call_id: string;
            agent_id: string;
            asset_id: string;
            side: "BUY" | "SELL";
            horizon_hours: number;
            confidence: number;
            accepted_at: string;
            status: CallStatus;
            acceptance_receipt_hash: string;
            primary_feed: string;
            fallback_feed: string;
            primary_max_staleness_sec: number;
            fallback_max_staleness_sec: number;
            t0_grace_seconds: number;
            t0_extended_grace_seconds: number;
          }
        | undefined) ?? null
    );
  },
};

// ─── Anchors / resolutions ───────────────────────────────────────────────────

export const anchorsRepo = {
  setT0(
    db: Database.Database,
    input: {
      call_id: string;
      t0: string;
      p0: string;
      feed: string;
      source_id: string;
      anchored_at: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO t0_anchors (call_id, t0, p0, feed, source_id, anchored_at)
       VALUES (@call_id, @t0, @p0, @feed, @source_id, @anchored_at)
       ON CONFLICT(call_id) DO UPDATE SET
         t0 = excluded.t0, p0 = excluded.p0, feed = excluded.feed,
         source_id = excluded.source_id, anchored_at = excluded.anchored_at`,
    ).run(input);
  },

  getT0(
    db: Database.Database,
    call_id: string,
  ): {
    t0: string;
    p0: string;
    feed: string;
    source_id: string;
    anchored_at: string;
  } | null {
    return (
      (prep(
        db,
        "SELECT t0, p0, feed, source_id, anchored_at FROM t0_anchors WHERE call_id = ?",
      ).get(call_id) as
        | {
            t0: string;
            p0: string;
            feed: string;
            source_id: string;
            anchored_at: string;
          }
        | undefined) ?? null
    );
  },
};

export const resolutionsRepo = {
  setResolution(
    db: Database.Database,
    input: {
      call_id: string;
      t1: string;
      p1: string;
      t1_feed: string;
      signed_return: string;
      outcome: Outcome;
      call_score: number | null;
      resolved_at: string;
    },
  ): void {
    prep(
      db,
      `INSERT INTO t1_resolutions
       (call_id, t1, p1, t1_feed, signed_return, outcome, call_score, resolved_at)
       VALUES (@call_id, @t1, @p1, @t1_feed, @signed_return, @outcome, @call_score, @resolved_at)
       ON CONFLICT(call_id) DO UPDATE SET
         t1 = excluded.t1, p1 = excluded.p1, t1_feed = excluded.t1_feed,
         signed_return = excluded.signed_return, outcome = excluded.outcome,
         call_score = excluded.call_score, resolved_at = excluded.resolved_at`,
    ).run(input);
  },

  loadFullCall(
    db: Database.Database,
    call_id: string,
  ): {
    submission: {
      call_id: string;
      agent_id: string;
      client_order_id: string;
      asset_id: string;
      side: "BUY" | "SELL";
      horizon_hours: number;
      confidence: number;
      submitted_at: string;
      accepted_at: string;
      status: CallStatus;
      rationale: string | null;
      strategy_tag: string | null;
    };
    preflight: {
      murmur_score: number;
      murmur_playbook: string;
      risk_flags: string[];
      data_freshness_seconds: number;
      market_regime: string;
    };
    acceptance_receipt: {
      hash: string;
      filecoin_cid: string | null;
    };
    t0: { t0: string; p0: string; feed: string } | null;
    resolution:
      | {
          t1: string;
          p1: string;
          t1_feed: string;
          signed_return: string;
          outcome: string;
          call_score: number | null;
          resolved_at: string;
          receipt_hash: string;
          filecoin_cid: string | null;
        }
      | null;
  } | null {
    const subRow = prep(
      db,
      `SELECT s.*, p.murmur_score, p.murmur_playbook, p.risk_flags_json,
              p.data_freshness_seconds, p.market_regime,
              ar.receipt_hash AS acceptance_hash, ar.filecoin_cid AS acceptance_cid
       FROM submissions s
       JOIN preflights p ON p.call_id = s.call_id
       LEFT JOIN receipts ar ON ar.call_id = s.call_id AND ar.kind = 'acceptance'
       WHERE s.call_id = ?`,
    ).get(call_id) as Record<string, unknown> | undefined;
    if (!subRow) return null;
    const t0Row = prep(
      db,
      "SELECT t0, p0, feed FROM t0_anchors WHERE call_id = ?",
    ).get(call_id) as { t0: string; p0: string; feed: string } | undefined;
    const resRow = prep(
      db,
      `SELECT r.*, rec.receipt_hash AS resolution_hash, rec.filecoin_cid AS resolution_cid
       FROM t1_resolutions r
       LEFT JOIN receipts rec ON rec.call_id = r.call_id AND rec.kind IN ('resolution','re_resolution')
       WHERE r.call_id = ?
       ORDER BY rec.created_at DESC
       LIMIT 1`,
    ).get(call_id) as Record<string, unknown> | undefined;
    return {
      submission: {
        call_id: subRow.call_id as string,
        agent_id: subRow.agent_id as string,
        client_order_id: subRow.client_order_id as string,
        asset_id: subRow.asset_id as string,
        side: subRow.side as "BUY" | "SELL",
        horizon_hours: subRow.horizon_hours as number,
        confidence: subRow.confidence as number,
        submitted_at: subRow.submitted_at as string,
        accepted_at: subRow.accepted_at as string,
        status: subRow.status as CallStatus,
        rationale: (subRow.rationale as string) ?? null,
        strategy_tag: (subRow.strategy_tag as string) ?? null,
      },
      preflight: {
        murmur_score: subRow.murmur_score as number,
        murmur_playbook: subRow.murmur_playbook as string,
        risk_flags: JSON.parse(subRow.risk_flags_json as string),
        data_freshness_seconds: subRow.data_freshness_seconds as number,
        market_regime: subRow.market_regime as string,
      },
      acceptance_receipt: {
        hash: subRow.acceptance_hash as string,
        filecoin_cid: (subRow.acceptance_cid as string) ?? null,
      },
      t0: t0Row ?? null,
      resolution: resRow
        ? {
            t1: resRow.t1 as string,
            p1: resRow.p1 as string,
            t1_feed: resRow.t1_feed as string,
            signed_return: resRow.signed_return as string,
            outcome: resRow.outcome as string,
            call_score: (resRow.call_score as number | null) ?? null,
            resolved_at: resRow.resolved_at as string,
            receipt_hash: resRow.resolution_hash as string,
            filecoin_cid: (resRow.resolution_cid as string) ?? null,
          }
        : null,
    };
  },

  recordResolutionReceipt(
    db: Database.Database,
    input: {
      receipt_hash: `0x${string}`;
      call_id: string;
      canonical_json: string;
      filecoin_cid?: string;
      previous_hash: `0x${string}`;
      created_at: string;
      kind: "resolution" | "re_resolution";
    },
  ): void {
    prep(
      db,
      `INSERT INTO receipts
       (receipt_hash, call_id, kind, canonical_json, filecoin_cid, previous_hash, created_at)
       VALUES (@receipt_hash, @call_id, @kind, @canonical_json, @filecoin_cid, @previous_hash, @created_at)`,
    ).run({
      ...input,
      filecoin_cid: input.filecoin_cid ?? null,
    });
  },
};

// ─── Disputes ────────────────────────────────────────────────────────────────

export const disputesRepo = {
  insert(db: Database.Database, dispute: Dispute): void {
    prep(
      db,
      `INSERT INTO disputes
       (dispute_id, target_resolution_receipt_hash, grounds, notes, filed_by, filed_at, status, resolved_at, new_resolution_receipt_hash)
       VALUES (@dispute_id, @target_resolution_receipt_hash, @grounds, @notes, @filed_by, @filed_at, @status, @resolved_at, @new_resolution_receipt_hash)`,
    ).run({
      ...dispute,
      notes: dispute.notes ?? null,
    });
  },

  setStatus(
    db: Database.Database,
    dispute_id: string,
    status: DisputeStatus,
    resolved_at: string | null = null,
    new_resolution_receipt_hash: string | null = null,
  ): void {
    prep(
      db,
      `UPDATE disputes
       SET status = ?, resolved_at = ?, new_resolution_receipt_hash = ?
       WHERE dispute_id = ?`,
    ).run(status, resolved_at, new_resolution_receipt_hash, dispute_id);
  },

  listOpen(db: Database.Database): Dispute[] {
    return prep(
      db,
      "SELECT * FROM disputes WHERE status IN ('open','replay_in_progress') ORDER BY filed_at",
    ).all() as Dispute[];
  },
};

// ─── Claim challenges ────────────────────────────────────────────────────────

export const claimsRepo = {
  insert(db: Database.Database, c: ClaimChallenge): void {
    prep(
      db,
      `INSERT INTO claim_challenges
       (challenge_id, agent_id, target_kind, target_value, nonce, challenge_text, wallet_to_bind, expires_at, status, created_at)
       VALUES (@challenge_id, @agent_id, @target_kind, @target_value, @nonce, @challenge_text, @wallet_to_bind, @expires_at, @status, @created_at)`,
    ).run({
      challenge_id: c.challenge_id,
      agent_id: c.agent_id,
      target_kind: c.target_identity.kind,
      target_value: c.target_identity.value,
      nonce: c.nonce,
      challenge_text: c.challenge_text,
      wallet_to_bind: c.wallet_to_bind,
      expires_at: c.expires_at,
      status: c.status,
      created_at: c.expires_at,
    });
  },

  setStatus(
    db: Database.Database,
    challenge_id: string,
    status: ClaimChallenge["status"],
  ): void {
    prep(
      db,
      "UPDATE claim_challenges SET status = ? WHERE challenge_id = ?",
    ).run(status, challenge_id);
  },
};

// ─── Usage events (rail; no fees in v0.1) ────────────────────────────────────

export const usageRepo = {
  emit(db: Database.Database, event: UsageEvent): void {
    prep(
      db,
      `INSERT INTO usage_events (event_id, agent_id, kind, ts, attributes_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      event.event_id,
      event.agent_id ?? null,
      event.kind,
      event.ts,
      JSON.stringify(event.attributes ?? {}),
    );
  },

  count24h(db: Database.Database, kind: UsageEventKind): number {
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM usage_events
       WHERE kind = ? AND ts >= datetime('now', '-1 day')`,
    ).get(kind) as { n: number } | undefined;
    return row?.n ?? 0;
  },
};

// ─── Outreach attribution ────────────────────────────────────────────────────

export interface RefClickRow {
  ref: string;
  agent_slug: string | null;
  total: number;
  first_at: string;
  last_at: string;
}

export const refsRepo = {
  /** Bump the (ref, agent_slug) counter. Creates the row on first hit. */
  bumpClick(
    db: Database.Database,
    ref: string,
    agent_slug: string | null,
    nowIso: string,
  ): void {
    prep(
      db,
      `INSERT INTO ref_clicks (ref, agent_slug, total, first_at, last_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(ref, agent_slug) DO UPDATE SET
         total = total + 1,
         last_at = excluded.last_at`,
    ).run(ref, agent_slug, nowIso, nowIso);
  },

  /** Top referrers for one agent (ordered by total desc). */
  discoverersForAgent(
    db: Database.Database,
    agent_slug: string,
    limit = 5,
  ): RefClickRow[] {
    return prep(
      db,
      `SELECT ref, agent_slug, total, first_at, last_at
       FROM ref_clicks
       WHERE agent_slug = ?
       ORDER BY total DESC, last_at DESC
       LIMIT ?`,
    ).all(agent_slug, limit) as RefClickRow[];
  },

  /** Full ref leaderboard (top senders across all agents). */
  topSenders(
    db: Database.Database,
    limit = 50,
  ): Array<{ ref: string; total: number; agents_touched: number; last_at: string }> {
    return prep(
      db,
      `SELECT ref,
              SUM(total) AS total,
              COUNT(DISTINCT agent_slug) AS agents_touched,
              MAX(last_at) AS last_at
       FROM ref_clicks
       GROUP BY ref
       ORDER BY total DESC, last_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{
      ref: string;
      total: number;
      agents_touched: number;
      last_at: string;
    }>;
  },
};

// ─── Convenience: dedup_key builder ──────────────────────────────────────────

/**
 * Per the spec: dedup_key = (agent_id, asset_id, side, horizon_hours, t_bucket)
 * where t_bucket = floor(submitted_at, horizon_hours/4 hours).
 */
export function buildDedupKey(args: {
  agent_id: string;
  asset_id: string;
  side: "BUY" | "SELL";
  horizon_hours: number;
  submitted_at_iso: string;
}): string {
  const bucketHours = Math.max(1, args.horizon_hours / 4);
  const ms = Date.parse(args.submitted_at_iso);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid submitted_at_iso: ${args.submitted_at_iso}`);
  }
  const bucketMs = bucketHours * 3600 * 1000;
  const bucket = Math.floor(ms / bucketMs) * bucketMs;
  return `${args.agent_id}|${args.asset_id}|${args.side}|${args.horizon_hours}|${bucket}`;
}

// ─── Re-export ground type for migration knowledge ───────────────────────────

export const VERDICT_DB_SCHEMA_VERSION = 1 as const;

// ─── Friendly unique-violation parser ────────────────────────────────────────

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

// Suppress unused-import warning for DisputeGrounds (kept for downstream type
// re-exports and IDE hovers). — irrelevant since noUnusedLocals=false.
export type { DisputeGrounds };
