import { useStream } from "../../hooks/useStream.js";

/**
 * BOLD topbar — same anatomy as Topbar.tsx (system name + nav + status
 * dots) but slammed to ALL-CAPS bold mono and 56px tall with a thick
 * underline rule. Variant gate: ?variant=bold is preserved across links.
 */
export function BoldTopbar({ crumb }: { crumb?: string }) {
  const stream = useStream();
  const live = stream.status === "open";
  const v = "?variant=bold";

  return (
    <header
      className={
        "h-[56px] border-b-4 border-[var(--color-display)] bg-[var(--color-bg)] " +
        "flex items-center justify-between px-4 md:px-10 sticky top-0 z-30"
      }
    >
      <div className="flex items-center gap-5">
        <span className="inline-flex gap-1" aria-hidden>
          <span className="w-[7px] h-[7px] bg-[var(--color-display)]" />
          <span className="w-[7px] h-[7px] bg-[var(--color-display)]" />
          <span className="w-[7px] h-[7px] bg-[var(--color-display)]" />
          <span
            className={
              "w-[7px] h-[7px] " +
              (live ? "bg-[var(--color-accent)] bold-pulse" : "bg-[var(--color-border-vis)]")
            }
          />
        </span>
        <a
          href={"#/" + v}
          className="t-button text-[var(--color-display)] no-underline tracking-[0.2em] text-[15px] md:text-[17px]"
        >
          MURMUR.VERDICT
        </a>
        {crumb && (
          <span className="t-label hidden md:inline text-[var(--color-accent)]">
            ▌ {crumb}
          </span>
        )}
      </div>
      <nav className="flex items-center gap-3 md:gap-6">
        <a
          href={`#/leaderboard${v}`}
          className="t-button hidden md:inline text-[var(--color-secondary)] hover:text-[var(--color-display)]"
        >
          LEADERBOARD
        </a>
        <a
          href={`#/today${v}`}
          className="t-button hidden md:inline text-[var(--color-secondary)] hover:text-[var(--color-display)]"
        >
          TAPE
        </a>
        <a
          href={`#/launch${v}`}
          className="t-button bg-[var(--color-display)] text-[var(--color-bg)] px-4 py-2 hover:bg-[var(--color-accent)] hover:text-[var(--color-display)] press-feedback transition-colors duration-150 ease-out"
        >
          ▲ INSTALL
        </a>
      </nav>
    </header>
  );
}

/**
 * Helper: append the ?variant=bold gate to a hash href so the variant
 * sticks across in-app navigation. Caller passes the path WITHOUT the
 * leading `#/`.
 */
export function boldHref(path: string): string {
  if (path.startsWith("#")) {
    return path.includes("?") ? path : path + "?variant=bold";
  }
  const cleaned = path.replace(/^\/+/, "");
  return `#/${cleaned}${cleaned.includes("?") ? "" : "?variant=bold"}`;
}
