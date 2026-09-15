import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { CallDetail } from "../components/compact/CallDetail.js";
import { Ik } from "../icons.js";

/** #/calls/:id: the shareable permalink for a call; body shared with the drawer via <CallDetail/>. */
export function CallPage({ callId }: { callId: string }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span className="inline-flex items-center gap-1.5">
            <Ik name="verdict" />
            {/* The visible word `calls` names the crumb; no sr-only needed. */}
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
