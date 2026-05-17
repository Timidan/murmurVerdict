import { useEffect, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { MMark } from "../MMark.js";

interface CompactTopbarProps {
  /** Free-text crumb shown after the system identifier (e.g. "LB / TIER:ALL"). */
  crumb?: React.ReactNode;
}

/**
 * COMPACT cockpit chrome — 26px tall, single live-state dot, system name,
 * UTC clock, terminal nav. Single line, zero padding above/below.
 */
export function CompactTopbar({ crumb }: CompactTopbarProps) {
  const stream = useStream();
  const live = stream.status === "open";
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="h-[26px] flex items-stretch border-b border-[var(--color-border)] sticky top-0 z-30 bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 px-2 border-r border-[var(--color-border)]">
        <span
          aria-hidden
          className={
            "w-[5px] h-[5px] " +
            (live ? "bg-[var(--color-success)] ck-dot-live" : "bg-[var(--color-accent)]")
          }
        />
        <a
          href="#/"
          className="no-underline flex items-center"
          aria-label="MURMUR.VERDICT — home"
        >
          <MMark size={18} decorative />
        </a>
      </div>
      {crumb && (
        <div className="flex items-center px-2 border-r border-[var(--color-border)] ck-label whitespace-nowrap overflow-hidden">
          {crumb}
        </div>
      )}
      <nav className="flex-1 flex items-center justify-end gap-0">
        <CompactNavLink href="#/leaderboard">leaderboard</CompactNavLink>
        <CompactNavLink href="#/today">feed</CompactNavLink>
        <CompactNavLink href="#/launch">install</CompactNavLink>
        <CompactNavLink href="#/recruiters">recruiters</CompactNavLink>
        <span
          aria-hidden="true"
          className="px-2 ck-mono ck-dim border-l border-[var(--color-border)] tabular-nums"
        >
          {now.toISOString().slice(11, 19)}Z
        </span>
        <ThemeToggle />
        <span
          role="status"
          aria-live="polite"
          className={"px-2 ck-label border-l border-[var(--color-border)] " + (live ? "ck-pos" : "ck-neg")}
        >
          {live ? "live" : "offline"}
        </span>
      </nav>
    </header>
  );
}

function CompactNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="px-2 ck-label border-l border-[var(--color-border)] hover:text-[var(--color-display)] no-underline h-full flex items-center"
    >
      {children}
    </a>
  );
}
