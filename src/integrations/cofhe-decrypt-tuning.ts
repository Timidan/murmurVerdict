/**
 * Shared CoFHE decrypt tuning.
 *
 * The SDK's `decryptForView` / `decryptForTx` builders default their 404 retry
 * window to 10s (`DEFAULT_404_RETRY_TIMEOUT_MS` in
 * `@cofhe/sdk/core/decrypt/*Builder.ts`). A 404 there means "the threshold
 * network has not observed the ACL update yet" — not "this will never work".
 *
 * That default is shorter than what this repo has measured: after `openReveal`
 * (or a `grantDecryptAccess`) the threshold network needs roughly 5-30s to
 * observe the change (see `murmur-sealed-verdicts.live-smoke.ts`). So with SDK
 * defaults a perfectly healthy decrypt reports failure whenever indexing lands
 * in the 10-30s band — the read is abandoned before the data could exist.
 *
 * We therefore set the window past the observed worst case with margin. The
 * overall seal-output budget is separate and still capped by the SDK at 5min.
 *
 * IMPORTANT — this does NOT cover every ACL-lag rejection. `set404RetryTimeout`
 * bounds retries for 204/404 only (`isRetryableSubmitStatus` in
 * `@cofhe/sdk/core/decrypt/submitRetry.ts`); **403/Forbidden is fatal to the
 * SDK**. And 403 is precisely how this repo has observed ACL lag in practice —
 * see the `RevealDecryptor` contract in `fhenix-reveal-worker.ts` ("expected
 * 403 for ~5-30s") and the retry loop in `tools/operator-blind-roundtrip.ts`.
 *
 * So any caller that must survive ACL propagation needs its OWN retry around
 * the call; this constant is the shared deadline for that, not a substitute.
 * The reveal worker gets this for free by rescheduling failed jobs across
 * ticks; `tools/subscriber-unseal-granted-call.ts` wraps the call explicitly.
 */
export const COFHE_404_RETRY_TIMEOUT_MS = 45_000;
