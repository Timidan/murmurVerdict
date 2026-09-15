/**
 * CoFHE decrypt 404 retry window. The SDK default (10s) is shorter than the ~5-30s
 * the threshold network takes to observe an ACL change, so this sits past that.
 * It covers 204/404 only: 403 is fatal in the SDK and is how ACL lag usually shows,
 * so callers that must survive ACL propagation need their own retry.
 */
export const COFHE_404_RETRY_TIMEOUT_MS = 45_000;
