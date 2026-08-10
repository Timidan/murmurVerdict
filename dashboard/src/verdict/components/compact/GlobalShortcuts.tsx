import { useEffect, useRef } from "react";
import { isInDialog, isTypingTarget } from "../../lib/keyboard-target.js";
import { NAV_CHORDS } from "./nav-chords.js";

/**
 * Route chords: `g` then one of these keys. The key→route direction this
 * listener needs, inverted at module load from the canonical route→key map so
 * the two directions cannot drift (see nav-chords.ts).
 *
 * Inversion can only ever SHRINK the map, so it throws on a duplicate letter
 * rather than shipping a route that is silently unreachable by keyboard.
 */
const CHORDS: Record<string, string> = Object.entries(NAV_CHORDS).reduce(
  (acc, [href, key]) => {
    if (acc[key]) throw new Error(`nav chord collision: "${key}" → ${acc[key]} and ${href}`);
    acc[key] = href;
    return acc;
  },
  {} as Record<string, string>,
);

/**
 * Terminal-style navigation chords, mounted once at the router root. `g`
 * opens a ~900ms window; the second key jumps to its route as a hash
 * assignment (the same navigation every data row uses). Never fires while a
 * field or an open dialog owns the keystroke, never with modifiers held; Esc
 * or timeout cancels a pending chord.
 */
export function GlobalShortcuts() {
  const pending = useRef<number | null>(null);
  const armed = useRef(false);
  useEffect(() => {
    const clear = () => {
      armed.current = false;
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
        pending.current = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target) || isInDialog(e.target)) return;
      if (armed.current) {
        const href = CHORDS[e.key.toLowerCase()];
        clear();
        if (href) {
          e.preventDefault();
          window.location.hash = `#${href}`;
        }
        return;
      }
      if (e.key === "g") {
        armed.current = true;
        pending.current = window.setTimeout(clear, 900);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clear();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return null;
}
