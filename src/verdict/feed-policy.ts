import type { FeedContractRow } from "./repos/feed-availability-repo.js";
import { isoFromMs } from "./time.js";

export type FeedRefundAction = "none" | "credit" | "prorated";
export type FeedSlashAction = "none" | "reputation" | "stake";

export interface FeedSlaPolicy {
  grace_seconds: number;
  refund_action: FeedRefundAction;
  slash_action: FeedSlashAction;
  refund_rule: Record<string, unknown>;
  slash_rule: Record<string, unknown>;
}

export function deriveFeedRevealAfter(
  feed: Pick<
    FeedContractRow,
    "reveal_policy_json" | "max_latency_seconds" | "delivery_cadence_seconds"
  >,
  requested: string | undefined,
  now: Date,
): string {
  const policy = parseFeedJsonObjectStrict(
    feed.reveal_policy_json,
    "feed.reveal_policy_json",
  );
  if (policy.kind === "fixed_delay" && typeof policy.delay_seconds === "number") {
    const policyMinimumMs = now.getTime() + policy.delay_seconds * 1000;
    if (!requested) return isoFromMs(policyMinimumMs);

    const normalizedRequested = stripIsoMillis(requested);
    const requestedMs = Date.parse(normalizedRequested);
    if (!Number.isFinite(requestedMs)) return normalizedRequested;
    return isoFromMs(Math.max(requestedMs, policyMinimumMs));
  }
  if (requested) return stripIsoMillis(requested);
  const delaySeconds = Math.max(
    60,
    feed.max_latency_seconds ?? feed.delivery_cadence_seconds ?? 3600,
  );
  return isoFromMs(now.getTime() + delaySeconds * 1000);
}

export function publicFeedPolicy(
  feed: Pick<
    FeedContractRow,
    "reveal_policy_json" | "refund_rule_json" | "slash_rule_json"
  >,
): {
  reveal_policy: unknown;
  refund_rule: unknown;
  slash_rule: unknown;
} {
  return {
    reveal_policy: parseFeedJsonField<unknown>(
      feed.reveal_policy_json,
      "feed.reveal_policy_json",
    ),
    refund_rule: parseFeedJsonField<unknown>(
      feed.refund_rule_json,
      "feed.refund_rule_json",
    ),
    slash_rule: parseFeedJsonField<unknown>(
      feed.slash_rule_json,
      "feed.slash_rule_json",
    ),
  };
}

export function feedSlaPolicy(
  feed: Pick<
    FeedContractRow,
    "refund_rule_json" | "slash_rule_json" | "max_latency_seconds"
  >,
): FeedSlaPolicy {
  const refundRule = safeFeedJsonObject(feed.refund_rule_json);
  const slashRule = safeFeedJsonObject(feed.slash_rule_json);
  return {
    grace_seconds: feedMissedGraceSeconds(feed, refundRule),
    refund_action: feedRefundAction(refundRule),
    slash_action: feedSlashAction(slashRule),
    refund_rule: refundRule,
    slash_rule: slashRule,
  };
}

export function safeFeedJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseFeedJsonField<T>(raw: string, field: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${field} is malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseFeedJsonObjectStrict(raw: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${field} is malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function feedMissedGraceSeconds(
  feed: Pick<FeedContractRow, "max_latency_seconds">,
  refundRule: Record<string, unknown>,
): number {
  if (feed.max_latency_seconds !== null) {
    return Math.max(0, Math.floor(feed.max_latency_seconds));
  }
  const minutes = Number(refundRule.missed_delivery_grace ?? 0);
  if (!Number.isFinite(minutes)) return 0;
  return Math.max(0, Math.floor(minutes * 60));
}

function feedRefundAction(rule: Record<string, unknown>): FeedRefundAction {
  const kind = rule.kind;
  return kind === "credit" || kind === "prorated" ? kind : "none";
}

function feedSlashAction(rule: Record<string, unknown>): FeedSlashAction {
  const kind = rule.kind;
  return kind === "reputation" || kind === "stake" ? kind : "none";
}

function stripIsoMillis(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return value;
  return new Date(milliseconds).toISOString().replace(/\.\d+Z$/, "Z");
}
