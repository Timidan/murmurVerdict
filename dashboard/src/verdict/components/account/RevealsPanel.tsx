// Reveals — the duty list.
//
// A sealed call has to be revealed after its market closes. Your agent gets an
// exclusive window; after that, murmur's worker reveals it for you and the
// record says so. This panel answers two questions and nothing else: which
// calls still need you, and by when.
//
// Two words here are deliberately not interchangeable:
//
//   pending  nobody has revealed the call yet. It is still yours to do.
//   unknown  it WAS revealed, and murmur has no record of who did it. Those
//            are old calls, sealed before murmur tracked the sender.
//
// Showing "pending" for the second kind would hand an owner a job that is
// already finished.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import {
  verdictApi,
  type AccountRevealRow,
  type AccountRevealSource,
  type AccountRevealsView,
} from "../../api.js";
import { Ik } from "../../icons.js";
import { formatLocalDateTime } from "../../lib/date-time-format.js";
import { shortId } from "../../lib/display-format.js";
import { InlineError } from "../compact/InlineError.js";

export function RevealsPanel({ slug }: { slug: string }) {
  const [view, setView] = useState<AccountRevealsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your session expired. Sign in again.");
        return;
      }
      setView(await verdictApi.getAgentReveals(token, slug));
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = view?.reveals.filter((r) => r.reveal_source === "pending").length ?? 0;

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="seal" /> reveals
        </span>
        <span className={"ck-mono " + (open > 0 ? "ck-pos" : "ck-dim")}>
          {view ? `${open} open` : "…"}
        </span>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">
        <p className="ck-dim text-[12px]">
          {view?.fallback.enabled === false
            ? "This deployment runs no fallback. A call you do not reveal stays sealed."
            : "Reveal each call before its deadline. After the deadline murmur reveals it for you, and the record shows that murmur did it."}
        </p>

        {error && <InlineError error={error} className="text-[12px]" />}

        {loading && !view ? (
          <SkeletonRows />
        ) : !view || view.reveals.length === 0 ? (
          <p className="ck-mono ck-dim">No sealed calls yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
            {view.reveals.map((row) => (
              <RevealRow key={row.call_id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function RevealRow({ row }: { row: AccountRevealRow }) {
  const pending = row.reveal_source === "pending";
  return (
    <li className="grid grid-cols-[1fr_auto_auto] items-baseline gap-3 px-3 py-2">
      <span className="min-w-0">
        <a
          href={`#/calls/${encodeURIComponent(row.call_id)}`}
          className="ck-mono ck-pos no-underline hover:underline"
          title={row.onchain_call_id}
        >
          {shortId(row.onchain_call_id)}
        </a>
        <span className="ck-dim text-[12px] block">
          opens {formatLocalDateTime(row.reveal_open_at) ?? row.reveal_open_at}
        </span>
      </span>
      <span className="text-right">
        <span className="ck-label ck-dim block">deadline</span>
        <span
          className="ck-mono text-[12px]"
          title={
            row.deadline
              ? "After this moment murmur's worker reveals the call for you."
              : "This deployment runs no fallback worker, so there is no deadline."
          }
        >
          {row.deadline
            ? formatLocalDateTime(row.deadline) ?? row.deadline
            : "none"}
        </span>
      </span>
      <span className="text-right flex flex-col items-end gap-1">
        <StatusChip status={row.reveal_status} />
        <RevealedBy source={row.reveal_source} />
      </span>
      {pending && (
        <span className="col-span-3 ck-dim text-[12px]">
          If your agent misses the deadline, murmur reveals this call and the
          record shows murmur as the sender.
        </span>
      )}
    </li>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "revealed"
      ? "ck-pos"
      : status === "missed" || status === "invalid"
        ? "ck-neg"
        : "ck-dim";
  return <span className={`ck-mono text-[12px] ${tone}`}>{status}</span>;
}

/**
 * One word for who published the reveal.
 *
 * Green for the agent, because that is the outcome the owner wants. Dim for
 * murmur's fallback — it worked, but it is not the same thing. "unknown" is
 * stated as unknown rather than dressed up as either.
 */
function RevealedBy({ source }: { source: AccountRevealSource }) {
  const map: Record<AccountRevealSource, { word: string; cls: string; title: string }> = {
    agent: {
      word: "your agent",
      cls: "ck-pos",
      title: "Your agent revealed this call itself, inside its window.",
    },
    daemon_fallback: {
      word: "murmur",
      cls: "ck-dim",
      title: "Your agent missed the window, so murmur revealed the call.",
    },
    unattributed_external: {
      word: "someone else",
      cls: "ck-dim",
      title:
        "Another sender published this reveal. Revealing is permissionless on chain.",
    },
    unknown: {
      word: "unknown",
      cls: "ck-dim",
      title:
        "This call was revealed. Murmur has no record of who sent it, because it was sealed before murmur tracked the sender.",
    },
    pending: {
      word: "nobody yet",
      cls: "ck-pos",
      title: "Nobody has revealed this call. It is still yours to do.",
    },
  };
  const entry = map[source];
  return (
    <span className={`text-[12px] ${entry.cls}`} title={entry.title}>
      {entry.word}
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul className="border border-[var(--color-border)]">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_auto] items-center px-3 py-3 gap-3 border-b border-[var(--color-border)] last:border-b-0"
        >
          <div className="h-[10px] bg-[var(--color-border)] w-[50%]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[60px]" />
        </li>
      ))}
    </ul>
  );
}
