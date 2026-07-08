import type { submissionsRepo } from "./repos/sealed-call-submissions-repo.js";

export type ResolverContext = NonNullable<
  ReturnType<typeof submissionsRepo.loadResolverContext>
>;

export type ResolutionLifecycleLogEvent =
  | { kind: "oracle_unavailable"; call_id: string; phase: "t0" | "t1" }
  | { kind: "still_pending"; call_id: string; phase: "t0" | "t1"; reason: string };

export type ResolutionLifecycleLog = (line: ResolutionLifecycleLogEvent) => void;
