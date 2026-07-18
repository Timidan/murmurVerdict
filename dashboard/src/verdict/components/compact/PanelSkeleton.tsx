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
          <div className="h-[10px] bg-[var(--color-border)] w-[60%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[40px]" />
        </li>
      ))}
    </ul>
  );
}
