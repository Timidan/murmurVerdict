import { CompactTopbar } from "../components/compact/Topbar.js";
import { CallDetail } from "../components/compact/CallDetail.js";
import { Ik } from "../icons.js";

/**
 * Full #/calls/:id route — the canonical, shareable permalink for a call
 * (the target of every [V] verify link). The detail body is shared with the
 * in-context call drawer via <CallDetail/>; this page just frames it with the
 * topbar + footer chrome.
 */
export function CallPage({ callId }: { callId: string }) {
  return (
    <div className="mmr-shell min-h-dvh flex flex-col">
      <CompactTopbar
        crumb={
          <span className="inline-flex items-center gap-1.5">
            <Ik name="verdict" />
            {/* The word `calls` stays, so the crumb's accessible name is
                unchanged — no sr-only stand-in needed here. */}
            <span>
              calls <span className="ck-dim mx-1">/</span>
              <span className="ck-pos">{callId.slice(0, 8)}</span>
            </span>
          </span>
        }
      />

      <h1 className="sr-only">call {callId}</h1>

      <main className="flex-1 flex flex-col min-h-0">
        <CallDetail callId={callId} variant="page" />
      </main>

      <footer className="flex items-center gap-3 px-2 py-1 border-t border-[var(--color-border)] ck-mono ck-dim">
        <a href="#/" className="ck-mono ck-dim hover:ck-pos no-underline">
          ← home
        </a>
        <span>·</span>
        <a
          href="#/leaderboard"
          className="ck-mono ck-dim hover:ck-pos no-underline"
        >
          leaderboard
        </a>
        <span className="ml-auto ck-mono ck-dim">call · {callId.slice(0, 8)}</span>
      </footer>
    </div>
  );
}
