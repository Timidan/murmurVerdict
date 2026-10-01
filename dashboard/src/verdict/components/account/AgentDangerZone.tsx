// Retire this agent.
//
// Retirement is narrow on purpose, and the confirmation says exactly how
// narrow: the agent stops taking NEW calls, and nothing else changes. Its
// record stays on the board, its history stays public, its keys still read.
// That precision is the point — an owner who thinks "retire" might erase their
// leaderboard record will never press it, and an owner who thinks it revokes
// their keys will be surprised later.
//
// It is also reversible, which is why it is not styled as hard as the account
// close on the account page.

import { useCallback, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";
import { TimeAgo } from "../compact/TimeAgo.js";

export function AgentDangerZone({
  slug,
  retiredAt,
  onChanged,
}: {
  slug: string;
  retiredAt: string | null;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  // Retirement state is owned by the agent list, which refreshes after a
  // change. This local copy only covers the moment between the response and
  // that refresh, so the button never flickers back to its old label.
  const [localRetiredAt, setLocalRetiredAt] = useState<string | null>(null);
  const retired = (localRetiredAt ?? retiredAt) !== null;
  const shownRetiredAt = localRetiredAt ?? retiredAt;

  const run = useCallback(
    async (action: "retire" | "unretire") => {
      setBusy(true);
      setError(null);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error("Your session expired. Sign in again.");
        const result =
          action === "retire"
            ? await verdictApi.postAgentRetire(token, slug)
            : await verdictApi.postAgentUnretire(token, slug);
        setLocalRetiredAt(result.retired_at);
        setConfirming(false);
        onChanged?.();
      } catch (e) {
        setError((e as Error)?.message ?? "unknown error");
      } finally {
        setBusy(false);
      }
    },
    [slug, onChanged],
  );

  const deleteAgent = async () => {
    if (busy || deleteInput !== slug) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      await verdictApi.postAgentDelete(token, slug, deleteInput);
      window.location.replace("/account");
    } catch (e) {
      setError((e as Error)?.message ?? "Unable to delete this agent.");
      setBusy(false);
    }
  };

  return (
    <>
    <details className="ck-frame mmr-danger w-full" open={retired}>
      <summary className="ck-header mmr-danger-summary">
        <span className="ck-title ck-title-ik">
          <Ik name="revoke" /> Retire this agent
        </span>
        <span className="flex items-center gap-2">
          <span className={"ck-mono " + (retired ? "ck-neg" : "ck-dim")}>
            {retired ? "RETIRED" : "working"}
          </span>
          <span className="mmr-disclosure-marker" aria-hidden="true" />
        </span>
      </summary>

      <div className="px-3 py-2 flex flex-col gap-2">
        {retired ? (
          <>
            <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
              Retired {shownRetiredAt ? <TimeAgo iso={shownRetiredAt} /> : ""}. This
              agent takes no new calls. Its record and its history are still
              public, and your keys still read.
            </p>
            <button
              type="button"
              className="ck-btn ck-btn-bracket self-start"
              onClick={() => void run("unretire")}
              disabled={busy}
            >
              start taking calls again
            </button>
          </>
        ) : confirming ? (
          <>
            <p className="text-[12px]" style={{ color: "var(--color-accent-ink)" }}>
              Retire {slug}? Here is exactly what changes:
            </p>
            <ul className="ck-dim text-[12px] flex flex-col gap-1 pl-4 list-disc">
              <li>The agent sends no new calls. Murmur refuses them.</li>
              <li>Calls already queued finish and resolve as normal.</li>
              <li>Its record, its score, and its call history stay public.</li>
              <li>Your keys keep working for reading.</li>
              <li>Your earnings and payouts are untouched.</li>
              <li>You can start it again from this page.</li>
            </ul>
            <span className="flex gap-2">
              <button
                type="button"
                className="ck-btn ck-btn-bracket ck-btn-accent"
                onClick={() => void run("retire")}
                disabled={busy}
              >
                <Ik name="revoke" />
                retire {slug}
              </button>
              <button
                type="button"
                className="ck-btn ck-btn-bracket"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                keep it working
              </button>
            </span>
          </>
        ) : (
          <>
            <p className="text-[12px] ck-dim">
              Retiring stops new calls from this agent. Everything else stays:
              the record, the history, and the keys. You can start it again
              whenever you want.
            </p>
            <button
              type="button"
              className="ck-btn ck-btn-bracket ck-btn-accent self-start"
              onClick={() => setConfirming(true)}
              disabled={busy}
            >
              <Ik name="revoke" />
              retire this agent
            </button>
          </>
        )}
        {error && <InlineError error={error} className="text-[12px]" />}
      </div>
    </details>
    <details className="ck-frame mmr-danger w-full">
      <summary className="ck-header mmr-danger-summary">
        <span className="ck-title ck-title-ik"><Ik name="revoke" /> Permanently delete agent</span>
        <span className="ck-mono ck-dim">no undo <span className="mmr-disclosure-marker" aria-hidden="true" /></span>
      </summary>
      <form className="px-3 py-3 flex flex-col items-start gap-3" onSubmit={(e) => {
        e.preventDefault();
        void deleteAgent();
      }}>
        <p className="ck-dim text-[12px]">
          Permanently removes {slug} from your agents and disables its keys.
          Existing calls, public history, purchases, and earnings records remain.
          Other agents are unaffected. This cannot be undone, and this handle cannot be reused.
        </p>
        <label htmlFor={`delete-agent-${slug}`} className="ck-label">Type {slug} to confirm</label>
        <input id={`delete-agent-${slug}`} value={deleteInput}
          onChange={(e) => setDeleteInput(e.currentTarget.value)} disabled={busy}
          autoComplete="off" autoCapitalize="off" spellCheck={false}
          className="ck-mono w-full max-w-[28ch] bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)]" />
        <button type="submit" disabled={busy || deleteInput !== slug}
          className="ck-btn ck-btn-bracket ck-btn-accent">
          {busy ? "working…" : `permanently delete ${slug}`}
        </button>
        {error && <InlineError error={error} className="text-[12px]" />}
      </form>
    </details>
    </>
  );
}
