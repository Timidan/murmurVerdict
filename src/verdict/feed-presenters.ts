import type Database from "better-sqlite3";
import {
  agentsRepo,
} from "./repos/agents-repo.js";
import {
  feedContractsRepo,
  type FeedContractRow,
  type FeedPacketRow,
  type FeedSlaIncidentRow,
} from "./repos/feed-availability-repo.js";
import {
  feedAvailabilitySummary,
  feedReliabilityEnvelope,
} from "./feed-availability.js";
import { publicFeedContractMetadata } from "./feed-contract-metadata.js";
import { publicFeedPolicy } from "./feed-policy.js";
import { publicFeedSlaIncidentDetails } from "./feed-sla-incident-detail.js";

export interface PublicFeedProjectionOptions {
  now: Date;
}

export interface PublicFeed {
  feed_id: string;
  agent_id: string;
  agent_slug: string;
  name: string;
  description: string | null;
  status: string;
  venue: string;
  resolution_classes: string[];
  edge_classes: string[];
  covered_market_ids: string[];
  delivery_cadence_seconds: number | null;
  trigger_rules: unknown[];
  max_latency_seconds: number | null;
  subscriber_capacity: number;
  commercial_template: string;
  reveal_policy: unknown;
  refund_rule: unknown;
  slash_rule: unknown;
  reliability: ReturnType<typeof feedReliabilityEnvelope>;
  availability: ReturnType<typeof feedAvailabilitySummary>;
  created_at: string;
  updated_at: string;
}

export function publicFeed(
  db: Database.Database,
  row: FeedContractRow,
  opts: PublicFeedProjectionOptions,
): PublicFeed {
  const agent = agentsRepo.byId(db, row.agent_id);
  if (!agent) {
    throw new Error(`feed ${row.feed_id} references missing agent_id=${row.agent_id}`);
  }
  const metadata = publicFeedContractMetadata(row);
  const policy = publicFeedPolicy(row);
  return {
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    agent_slug: agent.display_slug,
    name: row.name,
    description: row.description,
    status: row.status,
    venue: row.venue,
    resolution_classes: metadata.resolution_classes,
    edge_classes: metadata.edge_classes,
    covered_market_ids: metadata.covered_market_ids,
    delivery_cadence_seconds: row.delivery_cadence_seconds,
    trigger_rules: metadata.trigger_rules,
    max_latency_seconds: row.max_latency_seconds,
    subscriber_capacity: row.subscriber_capacity,
    commercial_template: row.commercial_template,
    reveal_policy: policy.reveal_policy,
    refund_rule: policy.refund_rule,
    slash_rule: policy.slash_rule,
    reliability: feedReliabilityEnvelope(feedContractsRepo.reliability(db, row.feed_id)),
    availability: feedAvailabilitySummary(db, row, { now: opts.now }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicFeedPacket(row: FeedPacketRow): {
  packet_id: string;
  feed_id: string;
  agent_id: string;
  market_id: string | null;
  packet_kind: string;
  sequence: number;
  payload_schema: string;
  submitted_at: string;
  accepted_at: string;
  reveal_after: string;
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
  created_at: string;
} {
  return {
    packet_id: row.packet_id,
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    market_id: row.market_id,
    packet_kind: row.packet_kind,
    sequence: row.sequence,
    payload_schema: row.payload_schema,
    submitted_at: row.submitted_at,
    accepted_at: row.accepted_at,
    reveal_after: row.reveal_after,
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
    created_at: row.created_at,
  };
}

export function publicFeedSlaIncident(row: FeedSlaIncidentRow): {
  incident_id: string;
  feed_id: string;
  agent_id: string;
  incident_kind: string;
  status: string;
  expected_sequence: number;
  expected_delivery_deadline_at: string;
  detected_at: string;
  grace_seconds: number;
  refund_action: string;
  slash_action: string;
  fulfilled_packet_id: string | null;
  fulfilled_at: string | null;
  details: unknown;
  created_at: string;
  updated_at: string;
} {
  return {
    incident_id: row.incident_id,
    feed_id: row.feed_id,
    agent_id: row.agent_id,
    incident_kind: row.incident_kind,
    status: row.status,
    expected_sequence: row.expected_sequence,
    expected_delivery_deadline_at: row.expected_delivery_deadline_at,
    detected_at: row.detected_at,
    grace_seconds: row.grace_seconds,
    refund_action: row.refund_action,
    slash_action: row.slash_action,
    fulfilled_packet_id: row.fulfilled_packet_id,
    fulfilled_at: row.fulfilled_at,
    details: publicFeedSlaIncidentDetails(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
