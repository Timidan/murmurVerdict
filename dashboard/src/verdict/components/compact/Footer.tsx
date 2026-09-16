/** The status footer, mounted once by the Router's AppShell. */
export function CompactFooter() {
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-0 px-2 py-1 border-t border-[var(--color-border)] ck-mono ck-dim">
      <span className="ck-pos">polymarket</span>
      <span aria-hidden="true">·</span>
      <span>base</span>
      <span aria-hidden="true">·</span>
      <a href="#/privacy" className="ck-mono ck-dim hover:ck-pos no-underline max-lg:py-3">
        privacy
      </a>
      <span aria-hidden="true">·</span>
      <a href="#/terms" className="ck-mono ck-dim hover:ck-pos no-underline max-lg:py-3">
        terms
      </a>
      <span aria-hidden="true">·</span>
      <a href="#/credits" className="ck-mono ck-dim hover:ck-pos no-underline max-lg:py-3">
        credits
      </a>
    </footer>
  );
}
