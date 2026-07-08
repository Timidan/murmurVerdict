import { z } from "zod";

export const GatewayAttemptStatusSchema = z.enum([
  "queued",
  "submitted",
  "confirmed",
  "accepted",
  "failed_retryable",
  "failed_terminal",
]);

export const FhenixRevealStatusSchema = z.enum([
  "pending",
  "revealed",
  "invalid",
  "missed",
]);

export const GATEWAY_ATTEMPT_STATUSES = GatewayAttemptStatusSchema.options;
