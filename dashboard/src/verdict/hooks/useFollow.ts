import { useCallback, useEffect, useState } from "react";

const KEY = "murmur-verdict.follow.v1";

function read(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function write(set: Set<string>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Quota / disabled storage — silently ignore.
  }
}

/**
 * Follow state for v0.1 — localStorage-only. Returns the current
 * following flag for the given slug and a toggle function.
 *
 * Per V14_HANDOFF §11 (locked decision #3): the followed state shows
 * `× UNFOLLOW` (explicit reversibility) rather than a `[FOLLOWING]`
 * indicator. Components consume `following` and decide the label.
 */
export function useFollow(slug: string | undefined): {
  following: boolean;
  toggle: () => void;
} {
  const [followed, setFollowed] = useState<Set<string>>(() => read());

  // Stay in sync if another tab toggles follow.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setFollowed(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(() => {
    if (!slug) return;
    setFollowed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      write(next);
      return next;
    });
  }, [slug]);

  return {
    following: !!slug && followed.has(slug),
    toggle,
  };
}
