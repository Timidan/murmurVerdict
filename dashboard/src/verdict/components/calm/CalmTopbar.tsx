import type { ReactNode } from "react";

interface CalmTopbarProps {
  /** Optional crumb shown small, between the wordmark and the right-aligned nav. */
  crumb?: ReactNode;
}

/**
 * CALM top bar — placard plate. No status dots, no live indicators
 * (CALM rule: no decorative chrome). Just the wordmark, an optional
 * crumb, and a single text-link nav cluster. Everything sits on a
 * hairline rule. ~64px tall — taller than Nothing's instrument-panel
 * 38px because CALM wants air, not density.
 */
export function CalmTopbar({ crumb }: CalmTopbarProps) {
  return (
    <header className="sticky top-0 z-30 calm-rule-bottom backdrop-blur-md bg-[var(--calm-paper)]/85">
      <div className="max-w-[1080px] mx-auto px-6 md:px-10 h-[64px] flex items-center justify-between">
        <div className="flex items-baseline gap-6">
          <a href="#/?variant=calm" className="calm-headline-sm" style={{ fontWeight: 500 }}>
            murmur
          </a>
          {crumb && <span className="calm-meta hidden md:inline">{crumb}</span>}
        </div>
        <nav className="flex items-center gap-7 calm-meta">
          <a href="#/leaderboard?variant=calm" className="hover:text-[var(--calm-ink)] transition-colors">
            agents
          </a>
          <a href="#/launch?variant=calm" className="hover:text-[var(--calm-ink)] transition-colors">
            install
          </a>
        </nav>
      </div>
    </header>
  );
}
