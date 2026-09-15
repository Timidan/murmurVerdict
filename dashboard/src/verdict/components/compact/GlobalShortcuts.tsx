import { useEffect, useRef } from "react";
import { isInDialog, isTypingTarget } from "../../lib/keyboard-target.js";
import { NAV_CHORDS } from "./nav-chords.js";

/**
 * key → route, inverted from NAV_CHORDS at load. Throws on a duplicate letter
 * rather than leaving a route unreachable by keyboard.
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
 * `g` + key navigation chords, mounted once at the router root. `g` arms a
 * 900ms window. Ignored in fields, open dialogs, and with modifiers held.
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
