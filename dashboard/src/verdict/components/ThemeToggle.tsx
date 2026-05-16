// dashboard/src/verdict/components/ThemeToggle.tsx

import { useEffect, useState } from "react";
import { resolveTheme, STORAGE_KEY, type Theme } from "../ui/theme.js";

function readCurrent(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "paper"
    ? "paper"
    : "dark";
}

function apply(theme: Theme) {
  if (theme === "paper") {
    document.documentElement.setAttribute("data-theme", "paper");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const meta = document.getElementById("meta-theme-color");
  if (meta) meta.setAttribute("content", theme === "paper" ? "#FCF9F2" : "#000000");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
}

/**
 * Two-state ◐ button. Click flips between dark and paper. Persists to
 * localStorage["murmur.theme"]. Pre-mount value comes from the inline
 * bootstrap in dashboard/index.html so first paint is correct.
 *
 * Styled to match compact `ck-btn` discipline — no radius, 3×8 px,
 * Space Mono uppercase.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readCurrent());

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
      apply(next);
      setTheme(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function flip() {
    const next: Theme = theme === "paper" ? "dark" : "paper";
    apply(next);
    setTheme(next);
  }

  const label = theme === "paper" ? "DARK" : "PAPER";
  return (
    <button
      type="button"
      onClick={flip}
      aria-pressed={theme === "paper"}
      aria-label={`Switch to ${label.toLowerCase()} mode`}
      className="px-2 ck-label border-l border-[var(--color-border)] hover:text-[var(--color-display)] h-full flex items-center cursor-pointer"
    >
      <span aria-hidden className="mr-1">
        {theme === "paper" ? "◐" : "◑"}
      </span>
      {label}
    </button>
  );
}
