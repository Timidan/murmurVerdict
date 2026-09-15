/**
 * Panel/form-level error: bracket-prefixed, announced, accent-ink. Page-level
 * failures use <ErrorState/>. A block span, not <p>, so it nests validly
 * anywhere, including <label>.
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
