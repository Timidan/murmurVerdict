import { z } from "zod";

// ─── Paid inference feed taxonomy ───────────────────────────────────────────
//
// These are Murmur-native product classes, not venue-specific labels. A
// Polymarket YES/NO contract can be `event_binary`, `sports_match`, or
// `price_threshold` from a buyer's point of view even though the first
// adapter resolves every leg as a binary payout vector.

export const RESOLUTION_CLASSES = [
  "event_binary",
  "event_basket",
  "price_threshold",
  "price_direction",
  "range_prediction",
  "sports_match",
  "ranking_outcome",
  "yield_or_savings",
  "risk_avoidance",
] as const;
export const ResolutionClassSchema = z.enum(RESOLUTION_CLASSES);
export type ResolutionClass = z.infer<typeof ResolutionClassSchema>;

export const EDGE_CLASSES = [
  "latency",
  "domain",
  "tail-risk",
  "portfolio",
  "automation",
  "cross-market",
  "avoidance",
  "microstructure",
] as const;
export const EdgeClassSchema = z.enum(EDGE_CLASSES);
export type EdgeClass = z.infer<typeof EdgeClassSchema>;

export const COMMERCIAL_TEMPLATES = [
  "per_alert",
  "capacity_capped_subscription",
  "exclusive_auction",
  "basket_subscription",
  "streaming_escrow_subscription",
  "verifiable_profit_share",
] as const;
export const CommercialTemplateSchema = z.enum(COMMERCIAL_TEMPLATES);
export type CommercialTemplate = z.infer<typeof CommercialTemplateSchema>;

export const FEED_STATUSES = ["draft", "listed", "paused", "retired"] as const;
export const FeedStatusSchema = z.enum(FEED_STATUSES);
export type FeedStatus = z.infer<typeof FeedStatusSchema>;

export const FEED_PACKET_KINDS = [
  "verdict",
  "revision",
  "heartbeat",
  "abstain",
  "risk_warning",
] as const;
export const FeedPacketKindSchema = z.enum(FEED_PACKET_KINDS);
export type FeedPacketKind = z.infer<typeof FeedPacketKindSchema>;

export const FEED_SLA_STATUSES = ["on_time", "late", "unscheduled"] as const;
export const FeedSlaStatusSchema = z.enum(FEED_SLA_STATUSES);
export type FeedSlaStatus = z.infer<typeof FeedSlaStatusSchema>;
