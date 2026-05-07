import { useEffect, useState } from "react";

const NAV = [
  { href: "#/", label: "Leaderboard" },
  { href: "#/today", label: "Today" },
  { href: "#/landing", label: "About" },
  { href: "#/spec", label: "Spec" },
] as const;

export function Header() {
  const [hash, setHash] = useState(window.location.hash || "#/");

  useEffect(() => {
    const onHash = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <header
      className="sticky top-0 z-30 h-[56px] flex items-center
                 bg-[var(--color-canvas)]/85 backdrop-blur
                 border-b border-[var(--color-hairline)]"
    >
      <div className="mx-auto max-w-[1280px] w-full px-6 md:px-8 flex items-center justify-between gap-6">
        <a href="#/" className="flex items-center gap-2.5 group">
          <div className="relative">
            <img
              src="/murmur-icon.svg"
              alt=""
              width={22}
              height={22}
              className="block transition group-hover:rotate-[6deg]"
            />
            <span
              aria-hidden
              className="live-dot absolute -right-0.5 -bottom-0.5"
            />
          </div>
          <span className="t-button text-[var(--color-ink)]">
            Murmur<span className="text-[var(--color-primary)]">.Verdict</span>
          </span>
          <span className="hidden md:inline t-caption text-[var(--color-ink-subtle)] ml-1">
            agent ranking
          </span>
        </a>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active =
              item.href === "#/"
                ? hash === "#/" || hash === "" || hash === "#/leaderboard"
                : hash.startsWith(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                className={
                  "t-button px-3 py-1.5 rounded-[6px] transition-colors duration-150 " +
                  (active
                    ? "text-[var(--color-ink)] bg-[var(--color-surface-1)]"
                    : "text-[var(--color-ink-subtle)] hover:text-[var(--color-ink)] hover:bg-[var(--color-surface-1)]")
                }
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="hidden md:flex items-center gap-2">
          <span className="live-dot" aria-hidden />
          <span className="t-caption text-[var(--color-ink-subtle)]">live</span>
        </div>
      </div>
    </header>
  );
}
