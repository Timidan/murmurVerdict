import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  validateFeedCoveredMarkets,
} from "./feed-availability.js";
import {
  publicFeed,
  type PublicFeed,
} from "./feed-presenters.js";
import {
  feedContractsRepo,
} from "./repos/feed-availability-repo.js";
import {
  CommercialTemplateSchema,
  EdgeClassSchema,
  ERROR_CODES,
  FeedStatusSchema,
  MarketIdSchema,
  ResolutionClassSchema,
  SCHEMA_VERSION,
  VerdictError,
} from "./schema.js";
import { nowIso } from "./time.js";

export interface FeedContractSurfaceClock {
  now: () => Date;
}

export type FeedContractIdAdapter = () => string;

export interface FeedContractCreatedResponse {
  status: 201;
  body: {
    schema_version: typeof SCHEMA_VERSION;
    feed: PublicFeed;
  };
}

export interface FeedContractJsonResponseTarget {
  status(code: number): { json(body: FeedContractCreatedResponse["body"]): unknown };
}

export function sendFeedContractJsonResponse(
  res: FeedContractJsonResponseTarget,
  result: FeedContractCreatedResponse,
): void {
  res.status(result.status).json(result.body);
}

export function createFeedContractResponse(input: {
  db: Database.Database;
  agentId: string;
  body: unknown;
  newFeedId?: FeedContractIdAdapter;
} & FeedContractSurfaceClock): FeedContractCreatedResponse {
  const parsed = FeedCreateBodySchema.safeParse(input.body ?? {});
  if (!parsed.success) {
    throw new VerdictError(
      "feed contract failed schema validation",
      ERROR_CODES.schema_invalid,
      400,
      { issues: parsed.error.format() },
    );
  }
  const body = parsed.data;
  assertVenueSupported(body.venue);
  validateFeedCoveredMarkets(
    input.db,
    body.covered_market_ids,
    body.venue,
    body.resolution_classes,
  );

  const now = input.now();
  const createdAt = nowIso(now);
  const feedId = input.newFeedId?.() ?? randomUUID();
  feedContractsRepo.insert(input.db, {
    feed_id: feedId,
    agent_id: input.agentId,
    name: body.name,
    description: body.description ?? null,
    status: body.status,
    venue: body.venue,
    resolution_classes: body.resolution_classes,
    edge_classes: body.edge_classes,
    covered_market_ids: body.covered_market_ids,
    delivery_cadence_seconds: body.delivery_cadence_seconds ?? null,
    trigger_rules: body.trigger_rules,
    max_latency_seconds: body.max_latency_seconds ?? null,
    subscriber_capacity: body.subscriber_capacity,
    commercial_template: body.commercial_template,
    reveal_policy: body.reveal_policy,
    refund_rule: body.refund_rule,
    slash_rule: body.slash_rule,
    created_at: createdAt,
    updated_at: createdAt,
  });

  const row = feedContractsRepo.byId(input.db, feedId);
  if (!row) {
    throw new Error(`feed insert did not persist feed_id=${feedId}`);
  }
  return {
    status: 201,
    body: {
      schema_version: SCHEMA_VERSION,
      feed: publicFeed(input.db, row, { now }),
    },
  };
}

function assertVenueSupported(venue: string): void {
  if (venue !== "polymarket-gamma") {
    throw new VerdictError(
      "feed contracts currently support only venue='polymarket-gamma'",
      ERROR_CODES.asset_not_supported,
      422,
      { venue },
    );
  }
}

const feedTriggerRuleSchema = z
  .object({
    kind: z.string().min(2).max(48).regex(/^[a-z0-9_.-]+$/),
    description: z.string().min(3).max(280),
    max_latency_seconds: z.number().int().min(60).optional(),
  })
  .strict();

const feedRevealPolicySchema = z
  .object({
    kind: z.enum(["after_resolution", "after_horizon", "fixed_delay", "manual"]),
    delay_seconds: z.number().int().min(60).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === "fixed_delay" && v.delay_seconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixed_delay reveal policy requires delay_seconds",
        path: ["delay_seconds"],
      });
    }
  });

const feedRefundRuleSchema = z
  .object({
    kind: z.enum(["none", "prorated", "credit"]),
    missed_delivery_grace: z.number().int().min(0).max(30).optional(),
  })
  .strict();

const feedSlashRuleSchema = z
  .object({
    kind: z.enum(["none", "reputation", "stake"]),
    missed_delivery_threshold: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind !== "none" && v.missed_delivery_threshold === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slash rule requires missed_delivery_threshold unless kind='none'",
        path: ["missed_delivery_threshold"],
      });
    }
  });

export const FeedCreateBodySchema = z
  .object({
    name: z.string().min(3).max(80),
    description: z.string().max(500).optional(),
    status: FeedStatusSchema.default("draft"),
    venue: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9_.-]+$/)
      .default("polymarket-gamma"),
    resolution_classes: z.array(ResolutionClassSchema).min(1).max(8),
    edge_classes: z.array(EdgeClassSchema).min(1).max(8),
    covered_market_ids: z.array(MarketIdSchema).max(100).default([]),
    delivery_cadence_seconds: z.number().int().min(60).nullable().optional(),
    trigger_rules: z.array(feedTriggerRuleSchema).max(30).default([]),
    max_latency_seconds: z.number().int().min(60).nullable().optional(),
    subscriber_capacity: z.number().int().min(1).max(100_000).default(1),
    commercial_template: CommercialTemplateSchema,
    reveal_policy: feedRevealPolicySchema.default({ kind: "after_resolution" }),
    refund_rule: feedRefundRuleSchema.default({ kind: "none" }),
    slash_rule: feedSlashRuleSchema.default({ kind: "none" }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.delivery_cadence_seconds == null && v.trigger_rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "feed must declare a cadence or at least one trigger rule",
        path: ["delivery_cadence_seconds"],
      });
    }
    if (v.commercial_template === "exclusive_auction" && v.subscriber_capacity !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exclusive_auction feeds must have subscriber_capacity=1",
        path: ["subscriber_capacity"],
      });
    }
  });
