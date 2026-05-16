// dashboard/src/verdict/ui/theme.ts

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
