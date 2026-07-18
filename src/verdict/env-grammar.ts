/**
 * Shared environment-variable grammar.
 *
 * One definition of "what counts as a boolean env flag" so configuration
 * Modules stop hand-rolling drifting copies (some accepted yes/no, some
 * threw on it). Callers keep their own error TYPE — this only recognizes
 * tokens; it never throws.
 */

/**
 * Parse a boolean env token. Returns true/false for a recognized token, and
 * `undefined` for empty/unset OR an unrecognized value — the caller decides
 * whether `undefined` means "use the fallback" or "raise a config error".
 * Strict grammar is {true,1,false,0}; pass `{ yesNo: true }` to also accept
 * {yes,no}.
 */
export function parseBooleanToken(
  raw: string | undefined,
  opts?: { yesNo?: boolean },
): boolean | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  if (opts?.yesNo) {
    if (normalized === "yes") return true;
    if (normalized === "no") return false;
  }
  return undefined;
}

/**
 * THE Polymarket Gamma venue-snapshot kill switch. Default ON (Gamma is a
 * public key-less API and the resolver needs the adapter registered for any
 * admin-registered polymarket market); disabled only on an explicit
 * false/0/no. Single derivation shared by daemon-config, the live canaries,
 * and the API router so the three can never disagree.
 */
export function resolvePolymarketGammaEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanToken(env.MURMUR_POLYMARKET_GAMMA_ENABLED, { yesNo: true }) ??
    true
  );
}
