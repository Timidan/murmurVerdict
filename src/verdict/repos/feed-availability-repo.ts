import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import {
  feedContractMetadataJson,
  feedHasEdgeClass,
  feedHasResolutionClass,
} from "../feed-contract-metadata.js";
import type {
  CommercialTemplate,
  EdgeClass,
  FeedPacketKind,
  FeedSlaStatus,
  FeedStatus,
  ResolutionClass,
} from "../schema.js";

export interface FeedContractInsert {
  feed_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  status: FeedStatus;
  venue: string;
  resolution_classes: ResolutionClass[];
  edge_classes: EdgeClass[];
  covered_market_ids: string[];
  delivery_cadence_seconds: number | null;
  trigger_rules: unknown[];
  max_latency_seconds: number | null;
  subscriber_capacity: number;
  commercial_template: CommercialTemplate;
  reveal_policy: Record<string, unknown>;
  refund_rule: Record<string, unknown>;
  slash_rule: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FeedContractRow {
  feed_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  status: FeedStatus;
  venue: string;
  resolution_classes_json: string;
  edge_classes_json: string;
  covered_market_ids_json: string;
  delivery_cadence_seconds: number | null;
  trigger_rules_json: string;
  max_latency_seconds: number | null;
  subscriber_capacity: number;
  commercial_template: CommercialTemplate;
  reveal_policy_json: string;
  refund_rule_json: string;
  slash_rule_json: string;
  created_at: string;
  updated_at: string;
}

export interface FeedReliabilityRow {
  packets_total: number;
  on_time_packets: number;
  late_packets: number;
  unscheduled_packets: number;
  missed_packets: number;
  open_missed_packets: number;
  fulfilled_missed_packets: number;
  last_packet_at: string | null;
  last_missed_at: string | null;
}

export const feedContractsRepo = {
  insert(db: Database.Database, input: FeedContractInsert): void {
    const metadata = feedContractMetadataJson(input);
    prep(
      db,
      `INSERT INTO feed_contracts
       (feed_id, agent_id, name, description, status, venue,
        resolution_classes_json, edge_classes_json, covered_market_ids_json,
        delivery_cadence_seconds, trigger_rules_json, max_latency_seconds,
        subscriber_capacity, commercial_template, reveal_policy_json,
        refund_rule_json, slash_rule_json, created_at, updated_at)
       VALUES
       (@feed_id, @agent_id, @name, @description, @status, @venue,
        @resolution_classes_json, @edge_classes_json, @covered_market_ids_json,
        @delivery_cadence_seconds, @trigger_rules_json, @max_latency_seconds,
        @subscriber_capacity, @commercial_template, @reveal_policy_json,
        @refund_rule_json, @slash_rule_json, @created_at, @updated_at)`,
    ).run({
      feed_id: input.feed_id,
      agent_id: input.agent_id,
      name: input.name,
      description: input.description,
      status: input.status,
      venue: input.venue,
      resolution_classes_json: metadata.resolution_classes_json,
      edge_classes_json: metadata.edge_classes_json,
      covered_market_ids_json: metadata.covered_market_ids_json,
      delivery_cadence_seconds: input.delivery_cadence_seconds,
      trigger_rules_json: metadata.trigger_rules_json,
      max_latency_seconds: input.max_latency_seconds,
      subscriber_capacity: input.subscriber_capacity,
      commercial_template: input.commercial_template,
      reveal_policy_json: JSON.stringify(input.reveal_policy),
      refund_rule_json: JSON.stringify(input.refund_rule),
      slash_rule_json: JSON.stringify(input.slash_rule),
      created_at: input.created_at,
      updated_at: input.updated_at,
    });
  },

  byId(db: Database.Database, feed_id: string): FeedContractRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM feed_contracts WHERE feed_id = ? LIMIT 1`,
      ).get(feed_id) as FeedContractRow | undefined) ?? null
    );
  },

  list(
    db: Database.Database,
    opts: {
      status?: FeedStatus;
      agent_id?: string;
      venue?: string;
      edge_class?: EdgeClass | null;
      resolution_class?: ResolutionClass | null;
      limit?: number;
    } = {},
  ): FeedContractRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    if (opts.agent_id) {
      clauses.push("agent_id = ?");
      params.push(opts.agent_id);
    }
    if (opts.venue) {
      clauses.push("venue = ?");
      params.push(opts.venue);
    }
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const hasTaxonomyFilters = Boolean(opts.edge_class || opts.resolution_class);
    const sqlLimit = hasTaxonomyFilters ? "" : "LIMIT ?";
    const rows = prep(
      db,
      `SELECT * FROM feed_contracts
       ${where}
       ORDER BY created_at DESC
       ${sqlLimit}`,
    ).all(
      ...(hasTaxonomyFilters ? params : [...params, limit]),
    ) as FeedContractRow[];
    if (!hasTaxonomyFilters) return rows;
    return rows
      .filter((row) => feedHasEdgeClass(row, opts.edge_class))
      .filter((row) => feedHasResolutionClass(row, opts.resolution_class))
      .slice(0, limit);
  },

  reliability(db: Database.Database, feed_id: string): FeedReliabilityRow {
    const row = prep(
      db,
      `SELECT
         COUNT(*) AS packets_total,
         SUM(CASE WHEN sla_status = 'on_time' THEN 1 ELSE 0 END) AS on_time_packets,
         SUM(CASE WHEN sla_status = 'late' THEN 1 ELSE 0 END) AS late_packets,
         SUM(CASE WHEN sla_status = 'unscheduled' THEN 1 ELSE 0 END) AS unscheduled_packets,
         MAX(accepted_at) AS last_packet_at,
         (
           SELECT COUNT(*)
           FROM feed_sla_incidents i
           WHERE i.feed_id = @feed_id
             AND i.incident_kind = 'missed_packet'
         ) AS missed_packets,
         (
           SELECT COUNT(*)
           FROM feed_sla_incidents i
           WHERE i.feed_id = @feed_id
             AND i.incident_kind = 'missed_packet'
             AND i.status = 'open'
         ) AS open_missed_packets,
         (
           SELECT COUNT(*)
           FROM feed_sla_incidents i
           WHERE i.feed_id = @feed_id
             AND i.incident_kind = 'missed_packet'
             AND i.status = 'fulfilled_late'
         ) AS fulfilled_missed_packets,
         (
           SELECT MAX(detected_at)
           FROM feed_sla_incidents i
           WHERE i.feed_id = @feed_id
             AND i.incident_kind = 'missed_packet'
         ) AS last_missed_at
       FROM feed_packets
       WHERE feed_id = @feed_id`,
    ).get({ feed_id }) as
      | {
          packets_total: number | null;
          on_time_packets: number | null;
          late_packets: number | null;
          unscheduled_packets: number | null;
          missed_packets: number | null;
          open_missed_packets: number | null;
          fulfilled_missed_packets: number | null;
          last_packet_at: string | null;
          last_missed_at: string | null;
        }
      | undefined;
    return {
      packets_total: row?.packets_total ?? 0,
      on_time_packets: row?.on_time_packets ?? 0,
      late_packets: row?.late_packets ?? 0,
      unscheduled_packets: row?.unscheduled_packets ?? 0,
      missed_packets: row?.missed_packets ?? 0,
      open_missed_packets: row?.open_missed_packets ?? 0,
      fulfilled_missed_packets: row?.fulfilled_missed_packets ?? 0,
      last_packet_at: row?.last_packet_at ?? null,
      last_missed_at: row?.last_missed_at ?? null,
    };
  },

  listCadenceListed(
    db: Database.Database,
    opts: { limit?: number } = {},
  ): FeedContractRow[] {
    const limit = Math.max(1, Math.min(1_000, Math.floor(opts.limit ?? 500)));
    return prep(
      db,
      `SELECT * FROM feed_contracts
       WHERE status = 'listed'
         AND delivery_cadence_seconds IS NOT NULL
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(limit) as FeedContractRow[];
  },
};

export type FeedSlaIncidentStatus = "open" | "fulfilled_late";
export type FeedSlaIncidentKind = "missed_packet";

export interface FeedSlaIncidentInsert {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  incident_kind: FeedSlaIncidentKind;
  status: FeedSlaIncidentStatus;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: "none" | "credit" | "prorated";
  slash_action: "none" | "reputation" | "stake";
  details_json: string;
  created_at: string;
  updated_at: string;
}

export interface FeedSlaIncidentRow extends FeedSlaIncidentInsert {
  fulfilled_packet_id: string | null;
  fulfilled_at: string | null;
}

export const feedSlaIncidentsRepo = {
  insertMissed(db: Database.Database, input: FeedSlaIncidentInsert): boolean {
    const info = prep(
      db,
      `INSERT OR IGNORE INTO feed_sla_incidents
       (incident_id, feed_id, agent_id, incident_kind, status,
        expected_sequence, expected_delivery_deadline_at, detected_at,
        grace_seconds, refund_action, slash_action, fulfilled_packet_id,
        fulfilled_at, details_json, created_at, updated_at)
       VALUES
       (@incident_id, @feed_id, @agent_id, @incident_kind, @status,
        @expected_sequence, @expected_delivery_deadline_at, @detected_at,
        @grace_seconds, @refund_action, @slash_action, NULL,
        NULL, @details_json, @created_at, @updated_at)`,
    ).run(input);
    return info.changes > 0;
  },

  byFeedSequence(
    db: Database.Database,
    feed_id: string,
    expected_sequence: number,
  ): FeedSlaIncidentRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM feed_sla_incidents
         WHERE feed_id = ? AND expected_sequence = ?
         LIMIT 1`,
      ).get(feed_id, expected_sequence) as FeedSlaIncidentRow | undefined) ?? null
    );
  },

  markFulfilledByPacket(
    db: Database.Database,
    input: {
      feed_id: string;
      expected_sequence: number;
      packet_id: string;
      fulfilled_at: string;
      updated_at: string;
    },
  ): boolean {
    const info = prep(
      db,
      `UPDATE feed_sla_incidents
       SET status = 'fulfilled_late',
           fulfilled_packet_id = @packet_id,
           fulfilled_at = @fulfilled_at,
           updated_at = @updated_at
       WHERE feed_id = @feed_id
         AND expected_sequence = @expected_sequence
         AND status = 'open'`,
    ).run(input);
    return info.changes > 0;
  },

  list(
    db: Database.Database,
    opts: {
      feed_id?: string;
      status?: FeedSlaIncidentStatus;
      limit?: number;
    } = {},
  ): FeedSlaIncidentRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.feed_id) {
      clauses.push("feed_id = ?");
      params.push(opts.feed_id);
    }
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    return prep(
      db,
      `SELECT * FROM feed_sla_incidents
       ${where}
       ORDER BY detected_at DESC, expected_sequence DESC
       LIMIT ?`,
    ).all(...params, limit) as FeedSlaIncidentRow[];
  },
};

export interface FeedPacketInsert {
  packet_id: string;
  feed_id: string;
  agent_id: string;
  market_id: string | null;
  packet_kind: FeedPacketKind;
  sequence: number;
  payload_schema: string;
  submitted_at: string;
  accepted_at: string;
  reveal_after: string;
  delivery_deadline_at: string | null;
  sla_status: FeedSlaStatus;
  chain_id: number;
  contract_address: string;
  onchain_packet_id: string;
  submit_tx_hash: string;
  submit_log_index: number;
  packet_ct_hash: string;
  binary_index_ct_hash: string | null;
  confidence_ct_hash: string | null;
  created_at: string;
}

export interface FeedPacketRow extends FeedPacketInsert {}

export const feedPacketsRepo = {
  insert(db: Database.Database, input: FeedPacketInsert): void {
    prep(
      db,
      `INSERT INTO feed_packets
       (packet_id, feed_id, agent_id, market_id, packet_kind, sequence,
        payload_schema, submitted_at, accepted_at, reveal_after,
        delivery_deadline_at, sla_status, chain_id, contract_address,
        onchain_packet_id, submit_tx_hash, submit_log_index, packet_ct_hash,
        binary_index_ct_hash, confidence_ct_hash, created_at)
       VALUES
       (@packet_id, @feed_id, @agent_id, @market_id, @packet_kind, @sequence,
        @payload_schema, @submitted_at, @accepted_at, @reveal_after,
        @delivery_deadline_at, @sla_status, @chain_id, @contract_address,
        @onchain_packet_id, @submit_tx_hash, @submit_log_index, @packet_ct_hash,
        @binary_index_ct_hash, @confidence_ct_hash, @created_at)`,
    ).run(input);
    feedSlaIncidentsRepo.markFulfilledByPacket(db, {
      feed_id: input.feed_id,
      expected_sequence: input.sequence,
      packet_id: input.packet_id,
      fulfilled_at: input.accepted_at,
      updated_at: input.created_at,
    });
  },

  nextSequence(db: Database.Database, feed_id: string): number {
    const row = prep(
      db,
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM feed_packets
       WHERE feed_id = ?`,
    ).get(feed_id) as { next_sequence: number } | undefined;
    return row?.next_sequence ?? 1;
  },

  latestForFeed(db: Database.Database, feed_id: string): FeedPacketRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM feed_packets
         WHERE feed_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      ).get(feed_id) as FeedPacketRow | undefined) ?? null
    );
  },

  byFhenixEvent(
    db: Database.Database,
    input: {
      chain_id: number;
      contract_address: string;
      onchain_packet_id: string;
    },
  ): FeedPacketRow | null {
    return (
      (prep(
        db,
        `SELECT * FROM feed_packets
         WHERE chain_id = @chain_id
           AND contract_address = @contract_address
           AND onchain_packet_id = @onchain_packet_id
         LIMIT 1`,
      ).get(input) as FeedPacketRow | undefined) ?? null
    );
  },

  listForFeed(
    db: Database.Database,
    feed_id: string,
    limit = 50,
  ): FeedPacketRow[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return prep(
      db,
      `SELECT * FROM feed_packets
       WHERE feed_id = ?
       ORDER BY sequence DESC
       LIMIT ?`,
    ).all(feed_id, safeLimit) as FeedPacketRow[];
  },
};
