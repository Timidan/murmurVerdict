// ─── nav-chords — the one route→chord-key map ──────────────────────────────
// Route-first so the topbar can type-check it; <GlobalShortcuts/> inverts it.

/**
 * `g` then this key jumps to that route. Keys must stay unique; the inversion
 * in <GlobalShortcuts/> throws on a collision.
 */
export const NAV_CHORDS = {
  "/dashboard": "d",
  "/leaderboard": "l",
  "/today": "f",
  "/install": "i",
  "/recruiters": "r",
  "/account": "a",
} as const;
