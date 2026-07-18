import type { KeyboardEvent, ReactNode } from "react";

interface FormulaTipProps {
  label: string;
  formula: string;
  children?: ReactNode;
  className?: string;
}

/**
 * Tiny stat-header formula tooltip for COMPACT surfaces.
 * Hover/focus-visible show the formula; Escape blurs the trigger.
 */
export function FormulaTip({
  label,
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
      aria-label={`${label} formula: ${formula}`}
      onKeyDown={onKeyDown}
      className={
        "relative inline-flex cursor-help items-center gap-1 " +
        "[&:hover_.formula-tip]:translate-y-0 [&:hover_.formula-tip]:opacity-100 " +
        "[&:focus-visible_.formula-tip]:translate-y-0 [&:focus-visible_.formula-tip]:opacity-100 " +
        className
      }
    >
      <span className="ck-label">{children}</span>
      <span aria-hidden="true" className="ck-mono ck-dim text-[9px] leading-none">
        ?
      </span>
      <span
        aria-hidden="true"
        className={
          "formula-tip pointer-events-none absolute right-0 top-full z-50 mt-1 " +
          "w-max max-w-[240px] translate-y-1 border border-[var(--color-border-vis)] " +
          "bg-[var(--color-raised)] px-2 py-1 ck-mono text-[10px] leading-snug " +
          "text-[var(--color-primary)] opacity-0 transition-[opacity,transform] " +
          "duration-[140ms] ease-out"
        }
      >
        {formula}
      </span>
    </span>
  );
}

export function withFormulaTip(label: string, formula: string): ReactNode {
  return (
    <FormulaTip label={label} formula={formula}>
      {label}
    </FormulaTip>
  );
}
