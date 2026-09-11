// dashboard/src/verdict/components/ThemeToggle.tsx
//
// Compact-shell two-state toggle. Click flips between dark and paper.
// First-paint value comes from the inline bootstrap in dashboard/index.html;
// runtime apply is delegated to `applyTheme` in ../ui/theme.ts so there is
// a single source of truth for the DOM/meta/localStorage write.

import { useEffect, useState } from "react";
import { applyTheme, resolveTheme, STORAGE_KEY, type Theme } from "../ui/theme.js";

function readCurrent(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "paper"
    ? "paper"
    : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readCurrent());

  // Keep every mounted toggle in sync with the root attribute `applyTheme`
  // writes. The desktop and mobile toggles are two components holding two
  // copies of the same state, and a same-tab flip fires no `storage` event —
  // so one bar's label stayed on the old theme until it was clicked twice.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readCurrent()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Keep state in sync if another tab flips the value.
  useEffect(() => {
    function onStorage(ev: StorageEvent) {
      if (ev.key !== STORAGE_KEY) return;
      const next = resolveTheme({
        stored: ev.newValue,
        prefersLight:
          window.matchMedia &&
          window.matchMedia("(prefers-color-scheme: light)").matches,
      });
      if (next === theme) return; // idempotency short-circuit
      applyTheme(next);
      setTheme(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [theme]);

  function flip() {
    const next: Theme = theme === "paper" ? "dark" : "paper";
    applyTheme(next);
    setTheme(next);
  }

  const label = theme === "paper" ? "dark" : "paper";
  return (
    <button
      type="button"
      onClick={flip}
      aria-pressed={theme === "paper"}
      aria-label={`Switch to ${label} mode`}
      className="mmr-nav-link mmr-theme-toggle press-feedback"
    >
      <span aria-hidden className="mr-1">
        {theme === "paper" ? "◐" : "◑"}
      </span>
      {label}
    </button>
  );
}
