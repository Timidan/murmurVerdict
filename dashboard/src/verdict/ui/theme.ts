// Theme resolution + application primitives.
// The inline bootstrap script in dashboard/index.html duplicates this logic (it
// runs before the bundle). Change the resolution order or theme-color hex pair
// here and you must update it too.

export type Theme = "dark" | "paper";

export interface ResolveArgs {
  /** localStorage["murmur.theme"] value or null if absent. */
  stored: string | null;
  /** Result of `matchMedia("(prefers-color-scheme: light)").matches`. */
  prefersLight: boolean;
}

/**
 * Pure resolver — testable independently of `window`.
 * Order: stored if valid → system preference → dark.
 */
export function resolveTheme({ stored, prefersLight }: ResolveArgs): Theme {
  if (stored === "paper" || stored === "dark") return stored;
  return prefersLight ? "paper" : "dark";
}

export const STORAGE_KEY = "murmur.theme";

/** Theme-color meta values — kept in sync with the [data-theme] blocks in styles.css. */
export const THEME_COLOR_PAPER = "#FCF9F2";
export const THEME_COLOR_DARK = "#000000";

/** Apply a resolved theme: `data-theme`, theme-color meta, favicons, and localStorage. */
export function applyTheme(theme: Theme): void {
  if (theme === "paper") {
    document.documentElement.setAttribute("data-theme", "paper");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const meta = document.getElementById("meta-theme-color");
  if (meta) {
    meta.setAttribute("content", theme === "paper" ? THEME_COLOR_PAPER : THEME_COLOR_DARK);
  }
  const svg = document.getElementById("favicon-svg") as HTMLLinkElement | null;
  const ico = document.getElementById("favicon-ico") as HTMLLinkElement | null;
  const apple = document.getElementById("apple-touch") as HTMLLinkElement | null;
  if (svg) svg.href = `/brand/favicon-${theme}.svg`;
  if (ico) ico.href = `/brand/favicon-${theme}.ico`;
  if (apple) apple.href = `/brand/app-icon-${theme}.png`;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
}
