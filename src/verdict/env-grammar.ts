/** Shared env-var grammar. Recognizes tokens only and never throws; callers keep their own error type. */

/**
 * Parses {true,1,false,0}, plus {yes,no} with `yesNo`. Returns undefined for unset or unrecognized;
 * the caller decides between fallback and config error.
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
 * Polymarket Gamma kill switch, shared by daemon-config, the live canaries and the API router.
 * Default on (the resolver needs the adapter); off only on an explicit false/0/no.
 */
export function resolvePolymarketGammaEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    parseBooleanToken(env.MURMUR_POLYMARKET_GAMMA_ENABLED, { yesNo: true }) ??
    true
  );
}
