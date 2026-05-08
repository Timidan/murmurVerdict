import type { ReactNode } from "react";

/**
 * Endless headline strip — the same children rendered twice so the keyframe
 * can translate -50% and loop seamlessly. CSS-only; honors reduced-motion.
 *
 * Use sparingly: reserved for hero ornaments, not data.
 */
export function BoldMarquee({
  children,
  ornament = "▲",
}: {
  children: ReactNode;
  /** Glyph painted between each repetition. ▲ ▼ Σ ◆ ━ all good. */
  ornament?: string;
}) {
  const strip = (
    <div className="flex items-center gap-8 px-8">
      <span className="bold-headline-sm whitespace-nowrap">{children}</span>
      <span className="text-[var(--color-accent)] bold-headline-sm">
        {ornament}
      </span>
    </div>
  );
  return (
    <div className="overflow-hidden border-y-4 border-[var(--color-display)] bg-[var(--color-bg)] py-3">
      <div className="bold-marquee" aria-hidden>
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className="contents">
            {strip}
          </span>
        ))}
      </div>
    </div>
  );
}
