/**
 * The status footer, mounted once by the Router's AppShell — the same
 * arrangement as the topbar, and for the same reason: when pages owned it,
 * two drew their own and the rest had none.
 */
export function CompactFooter() {
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-0 px-2 py-1 border-t border-[var(--color-border)] ck-mono ck-dim">
      <span className="ck-pos">polymarket</span>
      <span aria-hidden="true">·</span>
      <span>base</span>
      <span aria-hidden="true">·</span>
      <a href="#/recruiters" className="ck-mono ck-dim hover:ck-pos no-underline max-lg:py-3">
        referrals
      </a>
      <span aria-hidden="true">·</span>
      <a href="#/privacy" className="ck-mono ck-dim hover:ck-pos no-underline max-lg:py-3">
        privacy
      </a>
      <span aria-hidden="true">·</span>
      <a
        href="https://github.com/Timidan/murmur"
        target="_blank"
        rel="noreferrer"
        className="ck-mono ck-dim hover:ck-pos no-underline max-lg:py-3"
      >
        github
      </a>
    </footer>
  );
}
