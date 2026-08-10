/**
 * The one inline error idiom: bracket-prefixed, announced, accent-ink.
 * Page-level failures use <ErrorState/>; this is for the panel/form-level
 * strings that previously rendered ad-hoc `[error] {msg}` divs and bare
 * ck-neg spans (4 competing idioms as of the 2026-07-17 audit).
 *
 * A `block` span rather than a <p>: role="alert" already carries the semantics,
 * and span is phrasing content, so the atom nests validly in EVERY container —
 * including <label>, where a <p> would be invalid — while `block` reproduces the
 * exact box a <p> had (preflight zeroes paragraph margins).
 */
export function InlineError({
  error,
  className,
}: {
  error: string;
  className?: string;
}) {
  return (
    <span
      role="alert"
      className={"block ck-neg" + (className ? " " + className : "")}
    >
      [error] {error}
    </span>
  );
}
