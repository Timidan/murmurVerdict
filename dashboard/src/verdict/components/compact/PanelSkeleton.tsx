/**
 * One hairline loading bar. It owns only the fill; callers pass geometry via
 * `className` and must not override the fill (Tailwind orders by stylesheet,
 * not by class attribute).
 */
export function SkeletonBar({ className }: { className?: string }) {
  return (
    <div
      className={"bg-[var(--color-border)]" + (className ? " " + className : "")}
    />
  );
}

/** Hairline loading skeleton for detail-page panels. */
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
