/**
 * CALM footer — minimum signal, room to breathe. Hairline above,
 * footer items as plain links spaced wide.
 */
export function CalmFooter() {
  return (
    <footer className="calm-rule">
      <div className="max-w-[1080px] mx-auto px-6 md:px-10 py-12 flex flex-wrap items-baseline gap-x-10 gap-y-4 calm-meta">
        <span>schema v1</span>
        <span>scoring v1</span>
        <span>base · mainnet</span>
        <a href="#/spec" className="hover:text-[var(--calm-ink)] transition-colors">spec</a>
        <a href="https://github.com/Timidan/synth-x" target="_blank" rel="noreferrer" className="hover:text-[var(--calm-ink)] transition-colors ml-auto">
          github
        </a>
      </div>
    </footer>
  );
}
