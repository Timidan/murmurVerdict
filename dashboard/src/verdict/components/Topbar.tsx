import { useEffect, useState } from "react";
import { useStream } from "../hooks/useStream.js";

interface TopbarProps {
  systemName?: string;
  oracleSource?: string;
  /** Optional crumb on the right (page-level breadcrumb context). */
  crumb?: React.ReactNode;
}

/**
 * 38px-tall instrument-panel chrome. Four square status dots on the left
 * (1 pulsing red while live), system identifier, optional crumb, oracle
 * source. No clock, no schema chips — clutter pass cut those.
 */
export function Topbar({
  systemName = "murmur.verdict",
  oracleSource = "chainlink + pyth",
  crumb,
}: TopbarProps) {
  const stream = useStream();
  const live = stream.status === "open";

  return (
    <header
      className={
        "h-[38px] border-b border-[var(--color-border)] bg-[var(--color-bg)] " +
        "flex items-center justify-between px-4 t-meta sticky top-0 z-30"
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
      <div className="flex items-center gap-6 text-[var(--color-secondary)]">
        <span className="hidden md:inline">{oracleSource}</span>
      </div>
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
