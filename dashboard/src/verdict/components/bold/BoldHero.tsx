import type { ReactNode } from "react";

/**
 * Asymmetric hero block: gigantic Doto numeral on the left, caption stack
 * jammed to the right with the rest left as void. Used at the top of
 * every BOLD page.
 */
export function BoldHero({
  digits,
  accentChar,
  eyebrow,
  caption,
  side,
  pulse = false,
}: {
  /** The string of digits/glyphs to slam huge. */
  digits: ReactNode;
  /** Optional single character that paints accent red (e.g. + / − / ▲). */
  accentChar?: string;
  /** ALL-CAPS lozenge above the headline. */
  eyebrow?: string;
  /** Sentence-case caption shown next to the digits. */
  caption?: ReactNode;
  /** Vertical side label (rotated 90°). */
  side?: string;
  /** When true, the digits gently breathe. */
  pulse?: boolean;
}) {
  return (
    <section className="bold-slab bold-slab-tall relative px-4 md:px-10 py-16 md:py-24">
      {side && (
        <span className="bold-side-label hidden lg:block absolute left-3 top-10">
          {side}
        </span>
      )}
      <div className="bold-asym">
        <div className="min-w-0">
          {eyebrow && (
            <p className="t-label text-[var(--color-accent)] mb-6">{eyebrow}</p>
          )}
          <div
            className={
              "bold-hero break-words " + (pulse ? "bold-pulse" : "")
            }
          >
            {accentChar && (
              <span className="bold-accent-char">{accentChar}</span>
            )}
            {digits}
          </div>
        </div>
        {caption && (
          <div className="self-end md:pb-8 max-w-[36ch]">
            <div className="bold-faint-text mb-3">— readout —</div>
            <div className="t-body text-[var(--color-primary)]">{caption}</div>
          </div>
        )}
      </div>
    </section>
  );
}
