// Dark/paper theme toggle. First paint comes from the bootstrap in
// dashboard/index.html; all writes go through `applyTheme`.

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

  // Sync every mounted toggle (desktop + mobile) with the root attribute; a
  // same-tab flip fires no `storage` event.
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
      if (next === theme) return;
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
