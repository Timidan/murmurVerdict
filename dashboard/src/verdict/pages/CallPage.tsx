import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
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
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="inline-flex items-center gap-1.5">
            <Ik name="verdict" />
            {/* The word `calls` stays, so the crumb's accessible name is
                unchanged — no sr-only stand-in needed here. */}
            <span>
              calls <span className="ck-dim mx-1">/</span>
              <span className="ck-pos">{callId.slice(0, 8)}</span>
            </span>
          </span></TopbarCrumb>

      <h1 className="sr-only">call {callId}</h1>

      <main className="flex-1 flex flex-col min-h-0">
        <CallDetail callId={callId} variant="page" />
      </main>

    </div>
  );
}
