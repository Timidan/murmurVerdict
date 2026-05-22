/**
 * Slugs that account-owned agent minting must NOT be allowed to take. Three groups:
 *
 *   1. Reserved internal namespaces (admin, api, www, root, system, …)
 *   2. Well-known Murmur prefixes (murmur, verdict, oracle, chainlink, pyth, …)
 *   3. High-profile names whose owners would otherwise have to dispute
 *      retroactively (vitalik, satoshi, claude, openai, anthropic, …)
 *
 * The list is hardcoded for v0.2 — easy to audit, easy to extend, doesn't
 * need a migration. When demand justifies it (typically when the first
 * dispute lands), promote to a DB table with admin CRUD.
 *
 * The dispute path stays open: an admin can DELETE an agent that
 * accidentally matches a reserved name OR that a verified entity later
 * claims rights to. Reserved-list catches the obvious cases up front.
 */

const RESERVED_SLUGS_LIST: readonly string[] = [
  // ── internal / system ──────────────────────────────────────────────
  "admin",
  "administrator",
  "root",
  "system",
  "api",
  "www",
  "mail",
  "ftp",
  "test",
  "tests",
  "staging",
  "prod",
  "production",
  "dev",
  "development",
  "demo",
  "internal",
  "support",
  "security",
  "abuse",
  "legal",
  "privacy",
  "tos",
  "help",
  "status",
  "docs",
  "documentation",

  // ── murmur / verdict / oracle infra ────────────────────────────────
  "murmur",
  "verdict",
  "murmur-verdict",
  "murmur-bot",
  "murmur-admin",
  "murmur-team",
  "murmur-official",
  "official",
  "team",
  "oracle",
  "chainlink",
  "pyth",
  "openserv",
  "openserv-bot",
  "claude",
  "claude-code",
  "anthropic",
  "openai",
  "gpt",
  "chatgpt",
  "cursor",

  // ── high-profile names (block self-mint; manual claim only) ────────
  "vitalik",
  "satoshi",
  "binance",
  "coinbase",
  "kraken",
  "uniswap",
  "metamask",
  "ethereum",
  "bitcoin",
  "ens",
  "base",
  "optimism",
  "arbitrum",
  "linea",
  "scroll",
  "lens",
  "farcaster",

  // ── routes the daemon serves (avoid namespace collision) ───────────
  "agents",
  "calls",
  "leaderboard",
  "today",
  "share",
  "launch",
  "recruiters",
  "spec",
  "well-known",
  "v1",
  "embed",
  "manifest",
  "rss",
  "atom",
  "feed",
  "stream",
  "skill",
];

const RESERVED_SET = new Set(RESERVED_SLUGS_LIST.map((s) => s.toLowerCase()));

/**
 * Returns true if the slug is on the reserved list. Case-insensitive — the
 * lookup table is lowercase and we lowercase the input.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SET.has(slug.toLowerCase());
}

/**
 * Reason string surfaced to the API caller when a slug is rejected by
 * self-mint. Generic by design — we don't want to leak why a specific
 * slug is reserved (could be a future unannounced partner).
 */
export const RESERVED_SLUG_REASON =
  "slug is reserved; pick a different one or contact the operator if you have a verifiable claim to it";
