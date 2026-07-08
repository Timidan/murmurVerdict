import { useEffect, useState } from "react";
import { useStream } from "../hooks/useStream.js";
import { MobileNavDrawer } from "./MobileNavDrawer.js";

interface TopbarProps {
  systemName?: string;
  /** Optional crumb on the right (page-level breadcrumb context). */
  crumb?: React.ReactNode;
}

/**
 * 38px-tall instrument-panel chrome. Four square status dots on the left
 * (1 pulsing red while live), system identifier, and optional crumb.
 * No clock or schema chips — clutter pass cut those.
 */
export function Topbar({
  systemName = "murmur.verdict",
  crumb,
}: TopbarProps) {
  const stream = useStream();
  const live = stream.status === "open";

  return (
    <header
      className={
        "h-[38px] border-b border-[var(--color-border)] bg-[var(--color-bg)] " +
        "flex items-center justify-between px-4 t-meta sticky top-0 z-30 relative"
      }
    >
      <div className="flex items-center gap-4">
        <StatusDots live={live} />
        <a href="#/" className="text-[var(--color-display)] font-bold no-underline">
          {systemName}
        </a>
        {crumb && (
          <span className="text-[var(--color-secondary)] hidden md:inline">
            {crumb}
          </span>
        )}
      </div>
      <nav className="flex items-center gap-5 text-[var(--color-secondary)]">
        <a href="#/leaderboard" className="hidden md:inline hover:text-[var(--color-display)]">leaderboard</a>
        <a href="#/today" className="hidden md:inline hover:text-[var(--color-display)]">today</a>
        <a href="#/recruiters" className="hidden lg:inline hover:text-[var(--color-display)]">recruiters</a>
        <a href="#/account" className="hidden md:inline hover:text-[var(--color-display)]">account</a>
        <a
          href="#/launch"
          className="t-button border border-[var(--color-display)] text-[var(--color-display)] px-3 py-1 hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] transition-colors duration-150 ease-out press-feedback"
        >
          INSTALL
        </a>
        <MobileNavDrawer />
      </nav>
    </header>
  );
}

function StatusDots({ live }: { live: boolean }) {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      <span className="w-[5px] h-[5px] bg-[var(--color-display)]" />
      <span className="w-[5px] h-[5px] bg-[var(--color-display)]" />
      <span className="w-[5px] h-[5px] bg-[var(--color-display)]" />
      <span
        className={
          "w-[5px] h-[5px] " +
          (live
            ? "bg-[var(--color-accent)] nothing-live"
            : "bg-[var(--color-border-vis)]")
        }
      />
    </span>
  );
}

/** A standalone clock readout. Use only on dense dashboards where time matters. */
export function TopbarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-[13px] text-[var(--color-display)] tabular-nums">
      {now.toISOString().slice(11, 19)} UTC
    </span>
  );
}
