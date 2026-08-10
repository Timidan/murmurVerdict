/**
 * One hairline loading bar — the atom every skeleton on the dashboard composes.
 *
 * It owns exactly one property: the gray fill (`--color-border`). Everything
 * geometric — height, width, grid self-alignment — is the caller's, passed in
 * through `className`, because no two skeletons size their bars alike; even the
 * two bars inside `PanelSkeleton` below disagree on both height and width.
 *
 * That split is deliberate, not stylistic. Tailwind resolves competing
 * utilities by their order in the generated stylesheet, never by their order in
 * the `class` attribute, so a caller passing `bg-…` here could not reliably
 * beat the base fill. The contract is therefore: callers ADD properties, they
 * never contradict one. Nothing in the shell needs to: every loading state now
 * composes this atom — the last two holdouts, the agent ladder and the sender
 * ladder, traded their `bg-[var(--color-surface)] rounded-sm` bars for the
 * hairline fill and the shell's square corners. A skeleton that genuinely
 * needs a different fill, a radius or a pulse has to change the atom, not
 * smuggle it through `className`.
 *
 * No shimmer, no spinner, per DESIGN.md §10.
 */
export function SkeletonBar({ className }: { className?: string }) {
  return (
    <div
      className={"bg-[var(--color-border)]" + (className ? " " + className : "")}
    />
  );
}

/**
 * Shared hairline loading skeleton for detail-page panels (call log, market
 * heat, agent ladder, verdicts, today feed). Renders `rows` hairline gray bar
 * rows matching FeedSkeleton / AccountPage's SkeletonRows — no spinner, no
 * shimmer, per DESIGN.md §10. Replaces the old bare `[loading…]` panel text.
 */
export function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="m-0 p-0 list-none">
      {Array.from({ length: rows }, (_, i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_auto] items-center px-2 py-2 gap-3 border-b border-[var(--color-border)]"
        >
          <SkeletonBar className="h-[10px] w-[60%]" />
          <SkeletonBar className="h-[8px] w-[40px]" />
        </li>
      ))}
    </ul>
  );
}
