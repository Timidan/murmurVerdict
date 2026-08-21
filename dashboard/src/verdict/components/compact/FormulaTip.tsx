import type { KeyboardEvent, ReactNode } from "react";

interface FormulaTipProps {
  label: string;
  /**
   * Plain-language definition, one short active sentence. This is what the
   * reader actually needs; the formula below it is the proof, not the answer.
   * See dashboard/COPY.md §5 ("tooltip pattern").
   */
  plain?: string;
  formula: string;
  children?: ReactNode;
  className?: string;
}

/**
 * Tiny stat-header definition tooltip for COMPACT surfaces.
 * Hover/focus-visible show the definition; Escape blurs the trigger.
 *
 * The trigger mark is `ⓘ`, never `?`: a question mark next to a number reads
 * as "value unknown" (owner report, 2026-08-09 — `vs ?`, `wr ?`, `trend ?`).
 */
export function FormulaTip({
  label,
  plain,
  formula,
  children = label,
  className = "",
}: FormulaTipProps) {
  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <span
      tabIndex={0}
      aria-label={plain ? `${label} — ${plain} ${formula}` : `${label} formula: ${formula}`}
      onKeyDown={onKeyDown}
      onClick={
        // Safari only treats a non-form element as tappable-focusable when it
        // carries a click handler; the emptiness is the point — focus is the
        // mechanism, the `:focus` rule in compact.css does the reveal.
        () => {}
      }
      className={
        // `formula-tip-trigger` is a stable hook for the touch reveal rule in
        // compact.css (@media (hover: none)) — Tailwind's arbitrary variants
        // below cover pointer + keyboard only.
        "formula-tip-trigger relative inline-flex cursor-help items-center gap-1 " +
        "[&:hover_.formula-tip]:translate-y-0 [&:hover_.formula-tip]:opacity-100 " +
        "[&:focus-visible_.formula-tip]:translate-y-0 [&:focus-visible_.formula-tip]:opacity-100 " +
        className
      }
    >
      <span className="ck-label">{children}</span>
      <span aria-hidden="true" className="ck-dim text-[12px] leading-none">
        ⓘ
      </span>
      <span
        aria-hidden="true"
        className={
          "formula-tip pointer-events-none absolute right-0 top-full z-50 mt-1 " +
          "w-max max-w-[240px] translate-y-1 border border-[var(--color-border-vis)] " +
          "bg-[var(--color-raised)] px-2 py-1 text-[12px] leading-snug " +
          "text-[var(--color-primary)] opacity-0 transition-[opacity,transform] " +
          "duration-[140ms] ease-out"
        }
      >
        {plain ? (
          <>
            <span className="block">{plain}</span>
            <span className="block ck-dim mt-1">{formula}</span>
          </>
        ) : (
          formula
        )}
      </span>
    </span>
  );
}

export function withFormulaTip(
  label: string,
  formula: string,
  plain?: string,
): ReactNode {
  return (
    <FormulaTip label={label} plain={plain} formula={formula}>
      {label}
    </FormulaTip>
  );
}
