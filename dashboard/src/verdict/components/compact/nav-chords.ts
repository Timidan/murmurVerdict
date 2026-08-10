// ─── nav-chords — the one route→chord-key map ──────────────────────────────
//
// Two surfaces need this pairing and they need it in opposite directions:
// <GlobalShortcuts/> looks up a ROUTE by the key you typed, while the topbar
// looks up a KEY to print in a route's nav tip. Held as two literals they
// drifted silently in exactly one direction — a route added to the topbar with
// no entry on the shortcut side renders a tip advertising a chord that does
// nothing. So the map is written once, route-first (the topbar's direction,
// which is also the direction the compiler can check against `NavHref`), and
// the shortcut layer inverts it at module load.
//
// Route-first is also the honest primary: routes are the fixed set, letters are
// the mnemonic chosen for them.

/**
 * `g` then this key jumps to that route. Mirrors NAV_LINKS order.
 *
 * Letters are mnemonic, not positional: `f` is the feed (route `/today`) and
 * `d`/`l`/`i`/`r`/`a` name their destinations. Keys must stay unique — the
 * inversion in <GlobalShortcuts/> throws on a collision rather than letting one
 * route quietly shadow another.
 */
export const NAV_CHORDS = {
  "/dashboard": "d",
  "/leaderboard": "l",
  "/today": "f",
  "/install": "i",
  "/recruiters": "r",
  "/account": "a",
} as const;
