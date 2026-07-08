import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  feedContractsRepo,
  feedPacketsRepo,
  feedSlaIncidentsRepo,
  type FeedContractRow,
  type FeedPacketRow,
  type FeedReliabilityRow,
  type FeedSlaIncidentRow,
} from "./repos/feed-availability-repo.js";
import { feedSlaPolicy } from "./feed-policy.js";

export type HealthStatus = "healthy" | "degraded" | "failing";

interface ActionCounts {
  none: number;
  credit?: number;
  prorated?: number;
  reputation?: number;
  stake?: number;
}

export interface FeedAvailabilitySummary {
  proof_version: 1;
  feed_id: string;
  health_status: HealthStatus;
  reliability_score: number | null;
  scheduled_packets: number;
  on_time_packets: number;
  late_packets: number;
  missed_packets: number;
  open_missed_packets: number;
  fulfilled_missed_packets: number;
  next_expected_sequence: number | null;
  next_deadline_at: string | null;
  overdue: boolean;
  overdue_grace_seconds: number;
  refund_recommendations: ActionCounts;
  slash_recommendations: ActionCounts;
  payment_execution_enabled: false;
  proof_hash: string;
}

export interface FeedAvailabilityProof extends FeedAvailabilitySummary {
  generated_at: string;
  agent_id: string;
  feed: {
    status: string;
    venue: string;
    delivery_cadence_seconds: number | null;
    max_latency_seconds: number | null;
    refund_rule: Record<string, unknown>;
    slash_rule: Record<string, unknown>;
  };
  window: {
    from: string;
    to: string;
  };
  evidence: {
    delivered_packets: Array<{
      sequence: number;
      packet_id: string;
      accepted_at: string;
      delivery_deadline_at: string | null;
      sla_status: string;
      fhenix: {
        chain_id: number;
        contract_address: string;
        onchain_packet_id: string;
        submit_tx_hash: string;
        submit_log_index: number;
        packet_ct_hash: string;
        binary_index_ct_hash: string | null;
        confidence_ct_hash: string | null;
      };
    }>;
    missed_packets: Array<{
      expected_sequence: number;
      expected_delivery_deadline_at: string;
      detected_at: string;
      status: string;
      grace_seconds: number;
      refund_action: string;
      slash_action: string;
      fulfilled_packet_id: string | null;
      fulfilled_at: string | null;
    }>;
  };
}

export interface FeedAvailabilityReadInput {
  now: Date;
}

export interface FeedAvailabilityProofInput extends FeedAvailabilityReadInput {
  packetLimit?: number;
  incidentLimit?: number;
}

export function feedReliabilityEnvelope(
  input: FeedReliabilityRow,
  opts: { overdue?: boolean } = {},
): FeedReliabilityRow & {
  scheduled_packets: number;
  reliability_score: number | null;
  health_status: HealthStatus;
} {
  const scheduled = input.on_time_packets + input.late_packets + input.missed_packets;
  const healthStatus: HealthStatus =
    input.open_missed_packets > 0 || opts.overdue === true
      ? "failing"
      : input.missed_packets > 0 || input.late_packets > 0
        ? "degraded"
        : "healthy";
  return {
    ...input,
    scheduled_packets: scheduled,
    reliability_score: scheduled > 0 ? input.on_time_packets / scheduled : null,
    health_status: healthStatus,
  };
}

export function feedAvailabilitySummary(
  db: Database.Database,
  feed: FeedContractRow,
  input: FeedAvailabilityReadInput,
): FeedAvailabilitySummary {
  const proof = buildFeedAvailabilityProof(db, feed, {
    now: input.now,
    packetLimit: 0,
    incidentLimit: 500,
  });
  return {
    proof_version: proof.proof_version,
    feed_id: proof.feed_id,
    health_status: proof.health_status,
    reliability_score: proof.reliability_score,
    scheduled_packets: proof.scheduled_packets,
    on_time_packets: proof.on_time_packets,
    late_packets: proof.late_packets,
    missed_packets: proof.missed_packets,
    open_missed_packets: proof.open_missed_packets,
    fulfilled_missed_packets: proof.fulfilled_missed_packets,
    next_expected_sequence: proof.next_expected_sequence,
    next_deadline_at: proof.next_deadline_at,
    overdue: proof.overdue,
    overdue_grace_seconds: proof.overdue_grace_seconds,
    refund_recommendations: proof.refund_recommendations,
    slash_recommendations: proof.slash_recommendations,
    payment_execution_enabled: false,
    proof_hash: proof.proof_hash,
  };
}

export function buildFeedAvailabilityProof(
  db: Database.Database,
  feed: FeedContractRow,
  input: FeedAvailabilityProofInput,
): FeedAvailabilityProof {
  const generatedAt = stripIso(input.now);
  const reliability = feedContractsRepo.reliability(db, feed.feed_id);
  const packets = feedPacketsRepo
    .listForFeed(db, feed.feed_id, input.packetLimit ?? 100)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
  const incidents = feedSlaIncidentsRepo
    .list(db, {
      feed_id: feed.feed_id,
      limit: input.incidentLimit ?? 500,
    })
    .slice()
    .sort((a, b) => a.expected_sequence - b.expected_sequence);
  const policy = feedSlaPolicy(feed);
  const next = nextExpected(
    feed,
    packets,
    incidents,
    generatedAt,
    policy.grace_seconds,
  );
  const refundRecommendations = countRefundActions(incidents);
  const slashRecommendations = countSlashActions(incidents);
  const reliabilitySummary = availabilityReliabilitySummary(reliability, next.overdue);

  const hashPayload = {
    proof_version: 1,
    feed_id: feed.feed_id,
    agent_id: feed.agent_id,
    generated_at: generatedAt,
    feed: {
      status: feed.status,
      venue: feed.venue,
      delivery_cadence_seconds: feed.delivery_cadence_seconds,
      max_latency_seconds: feed.max_latency_seconds,
      refund_rule: policy.refund_rule,
      slash_rule: policy.slash_rule,
    },
    window: {
      from: feed.created_at,
      to: generatedAt,
    },
    next_expected_sequence: next.sequence,
    next_deadline_at: next.deadline_at,
    overdue: next.overdue,
    overdue_grace_seconds: next.grace_seconds,
    reliability: reliabilitySummary,
    refund_recommendations: refundRecommendations,
    slash_recommendations: slashRecommendations,
    evidence: {
      delivered_packets: packets.map(packetEvidence),
      missed_packets: incidents.map(incidentEvidence),
    },
    payment_execution_enabled: false,
  };
  const proofHash = createHash("sha256")
    .update(stableStringify(hashPayload))
    .digest("hex");

  return {
    proof_version: 1,
    feed_id: feed.feed_id,
    generated_at: generatedAt,
    agent_id: feed.agent_id,
    feed: hashPayload.feed,
    window: hashPayload.window,
    ...reliabilitySummary,
    next_expected_sequence: next.sequence,
    next_deadline_at: next.deadline_at,
    overdue: next.overdue,
    overdue_grace_seconds: next.grace_seconds,
    refund_recommendations: refundRecommendations,
    slash_recommendations: slashRecommendations,
    payment_execution_enabled: false,
    evidence: hashPayload.evidence,
    proof_hash: proofHash,
  };
}

function availabilityReliabilitySummary(
  input: FeedReliabilityRow,
  overdue: boolean,
): Pick<
  FeedAvailabilitySummary,
  | "health_status"
  | "reliability_score"
  | "scheduled_packets"
  | "on_time_packets"
  | "late_packets"
  | "missed_packets"
  | "open_missed_packets"
  | "fulfilled_missed_packets"
> {
  const envelope = feedReliabilityEnvelope(input, { overdue });
  return {
    health_status: envelope.health_status,
    scheduled_packets: envelope.scheduled_packets,
    reliability_score: envelope.reliability_score,
    on_time_packets: input.on_time_packets,
    late_packets: input.late_packets,
    missed_packets: input.missed_packets,
    open_missed_packets: input.open_missed_packets,
    fulfilled_missed_packets: input.fulfilled_missed_packets,
  };
}

function nextExpected(
  feed: FeedContractRow,
  packets: FeedPacketRow[],
  incidents: FeedSlaIncidentRow[],
  nowIso: string,
  graceSeconds: number,
): {
  sequence: number | null;
  deadline_at: string | null;
  overdue: boolean;
  grace_seconds: number;
} {
  const cadence = feed.delivery_cadence_seconds;
  if (cadence === null) {
    return {
      sequence: null,
      deadline_at: null,
      overdue: false,
      grace_seconds: graceSeconds,
    };
  }

  const latestPacket = packets.length > 0 ? packets[packets.length - 1] : null;
  const latestPacketSequence = latestPacket?.sequence ?? 0;
  const latestIncidentSequence = incidents.reduce(
    (max, incident) => Math.max(max, incident.expected_sequence),
    0,
  );
  const sequence = Math.max(latestPacketSequence, latestIncidentSequence) + 1;
  const baseMs = latestPacket
    ? Date.parse(latestPacket.accepted_at)
    : Date.parse(feed.created_at);
  const offset = latestPacket
    ? sequence - latestPacket.sequence
    : sequence;
  const deadlineMs = baseMs + cadence * 1_000 * offset;
  const nowMs = Date.parse(nowIso);
  const deadlineAt = stripIso(new Date(deadlineMs));
  return {
    sequence,
    deadline_at: deadlineAt,
    overdue:
      Number.isFinite(deadlineMs) &&
      Number.isFinite(nowMs) &&
      deadlineMs + graceSeconds * 1_000 <= nowMs,
    grace_seconds: graceSeconds,
  };
}

function packetEvidence(row: FeedPacketRow) {
  return {
    sequence: row.sequence,
    packet_id: row.packet_id,
    accepted_at: row.accepted_at,
    delivery_deadline_at: row.delivery_deadline_at,
    sla_status: row.sla_status,
    fhenix: {
      chain_id: row.chain_id,
      contract_address: row.contract_address,
      onchain_packet_id: row.onchain_packet_id,
      submit_tx_hash: row.submit_tx_hash,
      submit_log_index: row.submit_log_index,
      packet_ct_hash: row.packet_ct_hash,
      binary_index_ct_hash: row.binary_index_ct_hash,
      confidence_ct_hash: row.confidence_ct_hash,
    },
  };
}

function incidentEvidence(row: FeedSlaIncidentRow) {
  return {
    expected_sequence: row.expected_sequence,
    expected_delivery_deadline_at: row.expected_delivery_deadline_at,
    detected_at: row.detected_at,
    status: row.status,
    grace_seconds: row.grace_seconds,
    refund_action: row.refund_action,
    slash_action: row.slash_action,
    fulfilled_packet_id: row.fulfilled_packet_id,
    fulfilled_at: row.fulfilled_at,
  };
}

function countRefundActions(rows: FeedSlaIncidentRow[]): ActionCounts {
  return rows.reduce<ActionCounts>(
    (acc, row) => {
      acc[row.refund_action] = (acc[row.refund_action] ?? 0) + 1;
      return acc;
    },
    { none: 0, credit: 0, prorated: 0 },
  );
}

function countSlashActions(rows: FeedSlaIncidentRow[]): ActionCounts {
  return rows.reduce<ActionCounts>(
    (acc, row) => {
      acc[row.slash_action] = (acc[row.slash_action] ?? 0) + 1;
      return acc;
    },
    { none: 0, reputation: 0, stake: 0 },
  );
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}
