import { useEffect, useRef, useState } from "react";
import { verdictApi, ApiError, type FullCall } from "../../api.js";
import { Ik } from "../../icons.js";
import { Panel } from "./Panel.js";
import { ErrorState } from "./ErrorState.js";
import { PanelSkeleton } from "./PanelSkeleton.js";
import { PrivacyTierBadge } from "../PrivacyTierBadge.js";
import { TimeAgo } from "./TimeAgo.js";
import { formatScore } from "../../lib/score-format.js";
import { shortId } from "../../lib/display-format.js";
import { useStream } from "../../hooks/useStream.js";
import {
  isPendingCallStatus,
  isTerminalFailureStatus,
} from "@shared/wire-call-status";

/**
 * Call detail body for the #/calls/:id page and the call drawer; the variant
 * changes layout only. Fetches by `callId` and owns loading/error/not-found.
 */
export function CallDetail({
  callId,
  variant = "page",
}: {
  callId: string;
  variant?: "page" | "drawer";
}) {
  const [data, setData] = useState<FullCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Re-read on a stream event for this call (the streamed row lacks the
  // evidence) and on reconnect (events during downtime are lost).
  const { recentCalls, status } = useStream();
  const live = status === "open";
  const event = recentCalls.find((e) => e.call_id === callId);
  const streamKey = event ? event.type : null;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    let cancel = false;
    // Only a NEW call blanks the panels; a live refresh repaints in place.
    if (shown.current !== callId) {
      shown.current = callId;
      setData(null);
      setError(null);
      setNotFound(false);
    }
    verdictApi
      .call(callId)
      .then((r) => {
        if (cancel) return;
        setData(r);
        setError(null);
        setNotFound(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      });
    return () => {
      cancel = true;
    };
  }, [callId, streamKey, live]);

  // Privacy stat: which side of the reveal this call is on.
  const revealed = Boolean(data?.fhenix?.revealed_verdict);
  const subjectLabel = !data ? "" : revealed ? "revealed" : "sealed";
  const privacyTitle = revealed
    ? "The market closed and this call was opened, so the side and the confidence below are public. Before the reveal murmur held the plain text only on the optional /seal path. A buyer with paid access could read the call early."
    : "The call is sealed. Murmur cannot show it here, and the contract cannot publish it before the market's reveal time. On the standard path the agent seals the call in its own runtime, so murmur never holds the plain text. On the optional /seal path murmur does hold it, by design.";
  const outcomeText = !data
    ? ""
    : data.resolution
      ? outcomeWord(data.resolution.outcome)
      : callStateWord(data.submission.status);
  const outcomeTone = !data
    ? "ck-dim"
    : !data.resolution
      ? "ck-dim"
      : data.resolution.outcome === "win"
        ? "ck-pos"
        : data.resolution.outcome === "loss"
          ? "ck-neg"
          : "ck-dim";

  const page = variant === "page";
  // `grid-rows-[auto_minmax(0,1fr)]` keeps the stat ribbon at its natural
  // height and sends the flex-1 surplus to the panel row.
  const wrap = page
    ? "flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] min-h-0"
    : "flex flex-col";
  const statWrap = page
    ? "lg:col-span-3 grid grid-cols-3 border-b border-[var(--color-border)]"
    : "grid grid-cols-3 border-b border-[var(--color-border)]";
  // Page: merge adjacent right borders in the 3-col grid. Drawer: pull stacked
  // frames up 1px so the shared hairlines don't double.
  const panelCls = page ? "lg:border-r-0" : "-mt-px";
  const spanFull = page ? "lg:col-span-3" : "";

  return (
    <div className={wrap}>
      {notFound && (
        <div className={spanFull + " border-b border-[var(--color-border)]"}>
          <ErrorState kind="not_found" what="call" id={callId} detail={error ?? undefined} />
        </div>
      )}
      {!notFound && error && (
        <div className={spanFull + " border-b border-[var(--color-border)]"}>
          <ErrorState kind="error" what="call" id={callId} detail={error} />
        </div>
      )}

      {!error && !notFound && !data && (
        <div className={spanFull}>
          <PanelSkeleton rows={6} />
        </div>
      )}

      {data && (
        <>
          <div className={statWrap}>
            <Stat label="Privacy" value={subjectLabel} mono title={privacyTitle} />
            <Stat label="Outcome" value={outcomeText} tone={outcomeTone} />
            <Stat
              label="Score"
              value={formatScore(data.resolution?.call_score)}
              mono
              title="How good this call was. It pays the agent for being right and confident, and charges it for being wrong and confident."
            />
          </div>

          <Panel
            title={
              <>
                <Ik name="verdict" /> The call
              </>
            }
            className={panelCls}
          >
            <Kv
              k="Call ID"
              v={
                <span title={data.submission.call_id}>
                  {shortId(data.submission.call_id, 8, 5)}
                </span>
              }
              mono
            />
            <Kv
              k="Agent ID"
              v={
                <span title={data.submission.agent_id}>
                  {shortId(data.submission.agent_id, 8, 5)}
                </span>
              }
              mono
            />
            {data.submission.privacy_mode && (
              <div className="flex items-center justify-between px-2 py-1">
                <span className="ck-label ck-dim">Privacy</span>
                <PrivacyTierBadge mode={data.submission.privacy_mode} />
              </div>
            )}
            {data.submission.commit_hash && (
              <Kv
                k="Commit hash"
                v={
                  <span title={data.submission.commit_hash}>
                    {shortId(data.submission.commit_hash, 8, 5)}
                  </span>
                }
                mono
              />
            )}
            {data.fhenix && (
              <>
                {data.fhenix.revealed_verdict ? (
                  <>
                    {/* The venue's label, else the index; never an inferred direction. */}
                    <Kv
                      k="Side"
                      v={
                        data.fhenix.revealed_verdict.outcome_label ??
                        `outcome ${data.fhenix.revealed_verdict.binary_index}`
                      }
                      title="which of the venue's two outcomes this agent called. The venue names the pair; murmur records the index."
                    />
                    <Kv
                      k="Confidence"
                      v={`${(data.fhenix.revealed_verdict.confidence_bps / 100).toFixed(2)}%`}
                    />
                  </>
                ) : (
                  <>
                    <Kv k="Side" v="sealed" tone="ck-dim" />
                    <Kv k="Confidence" v="sealed" tone="ck-dim" />
                  </>
                )}
              </>
            )}
            {data.submission.submitted_at && (
              <Kv
                k="Sent"
                /* Absolute times: the lifecycle stamps sit within a minute. */
                v={<TimeAgo iso={data.submission.submitted_at} absolute />}
                title="when the agent sent this call"
              />
            )}
            <Kv
              k="Accepted"
              v={<TimeAgo iso={data.submission.accepted_at} absolute />}
              title="when murmur accepted the call and sealed it"
            />
            {data.submission.strategy_tag && (
              <Kv k="Strategy" v={data.submission.strategy_tag} />
            )}
          </Panel>

          <Panel
            title={
              <>
                <Ik name="resolve" /> Resolution
              </>
            }
            className={panelCls}
          >
            {/* Anchor rows: legacy native-price calls only. */}
            {data.t0 && (
              <>
                <Kv
                  k="Anchor time"
                  v={<TimeAgo iso={data.t0.t0} absolute />}
                  title="when the price was read at the start of this call"
                />
                <Kv
                  k="Anchor price"
                  v={data.t0.p0}
                  title="the starting price this call is measured from"
                />
                <Kv
                  k="Price source"
                  v={data.t0.feed}
                  title="the price feed that gave the anchor price"
                />
                <KvDivider />
              </>
            )}
            {data.resolution ? (
              <>
                <Kv
                  k="Market closed"
                  v={<TimeAgo iso={data.resolution.t1} absolute />}
                  title="when the market closed and the call became scorable"
                />
                {/* Venue calls carry no closing price or feed. */}
                {data.resolution.p1 !== null && data.resolution.p1 !== undefined && (
                  <Kv
                    k="Closing price"
                    v={data.resolution.p1}
                    title="the closing price, compared against the anchor price to score the call"
                  />
                )}
                {data.resolution.t1_feed !== null && data.resolution.t1_feed !== undefined && (
                  <Kv
                    k="Price source"
                    v={data.resolution.t1_feed}
                    title="the price feed that gave the closing price"
                  />
                )}
                {data.resolution.call_score !== null && (
                  <Kv
                    k="Score"
                    v={formatScore(data.resolution.call_score)}
                    title="How good this call was. It pays the agent for being right and confident, and charges it for being wrong and confident."
                  />
                )}
                <Kv
                  k="Scored"
                  v={<TimeAgo iso={data.resolution.resolved_at} absolute />}
                  title="when murmur scored this call"
                />
              </>
            ) : (
              <Kv
                k="Scored"
                v={
                  isPendingCallStatus(data.submission.status)
                    ? "not yet — the market has not settled"
                    : "no score — this call never reached a verdict"
                }
                tone="ck-dim"
              />
            )}
          </Panel>

          <Panel
            title={
              <>
                <Ik name="seal" /> On-chain proof
              </>
            }
            className={page ? undefined : "-mt-px"}
          >
            {data.fhenix ? (
              <>
                <Kv
                  k="Chain"
                  v={humanChain(data.fhenix.chain_id)}
                  title={String(data.fhenix.chain_id)}
                />
                <Kv
                  k="Contract"
                  v={
                    <ExplorerLink
                      address={data.fhenix.contract_address}
                      chainId={data.fhenix.chain_id}
                      kind="address"
                    />
                  }
                  mono
                />
                <Kv
                  k="On-chain call ID"
                  v={
                    <span className="ck-mono ck-pos" title={data.fhenix.onchain_call_id}>
                      {shortId(data.fhenix.onchain_call_id, 9, 6)}
                    </span>
                  }
                  mono
                  title="the id the Fhenix contract gave this call when it was sealed"
                />
                <KvDivider />
                <Kv
                  k="Reveal"
                  v={revealWord(data.fhenix.reveal_status)}
                  tone={revealTone(data.fhenix.reveal_status)}
                  title="whether the sealed call has been opened yet"
                />
                <Kv
                  k="Reveal opens"
                  v={<TimeAgo iso={data.fhenix.reveal_open_at} absolute />}
                  tone="ck-dim"
                  title="the earliest moment this call can be opened"
                />
                {data.fhenix.revealed_at && (
                  <Kv k="Revealed" v={<TimeAgo iso={data.fhenix.revealed_at} absolute />} />
                )}
                {data.fhenix.terminal_at && (
                  <Kv
                    k="Closed"
                    v={<TimeAgo iso={data.fhenix.terminal_at} absolute />}
                    tone="ck-dim"
                    title="when this call reached its final state on chain"
                  />
                )}
                {data.fhenix.invalid_reason && (
                  <Kv k="Why it failed" v={data.fhenix.invalid_reason} tone="ck-neg" />
                )}
              </>
            ) : (
              <Kv k="On-chain" v="this call is not on chain yet" tone="ck-dim" />
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  mono,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  mono?: boolean;
  title?: string;
}) {
  const cls = tone ?? "ck-pos";
  return (
    <div
      className="px-2 py-2 border-r border-[var(--color-border)] last:border-r-0 flex flex-col gap-1 min-w-0"
      title={title}
    >
      <span className="ck-label">{label}</span>
      <span
        className={(mono ? "ck-mono " : "") + cls + " ck-value truncate"}
      >
        {value || "—"}
      </span>
    </div>
  );
}

function Kv({
  k,
  v,
  mono,
  tone,
  title,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
  tone?: string;
  title?: string;
}) {
  return (
    <div
      className="grid grid-cols-[140px_1fr] gap-x-3 px-2 py-1 border-b border-[var(--color-border)]"
      title={title}
    >
      <span className="ck-label truncate">{k}</span>
      <span className={(mono ? "ck-mono " : "ck-mono ") + (tone ?? "ck-pos") + " break-all"}>
        {v}
      </span>
    </div>
  );
}

function KvDivider() {
  return <div className="h-2 border-b border-[var(--color-border)]" />;
}

function humanChain(chainId: number | string): string {
  const id = typeof chainId === "number" ? chainId : Number(chainId);
  if (id === 8453) return "base";
  if (id === 421614) return "arbitrum sepolia";
  return `chain ${id}`;
}

function revealTone(status: string): string {
  if (status === "revealed") return "ck-pos";
  if (status === "invalid" || status === "missed") return "ck-neg";
  return "ck-dim";
}

/** The reveal state, said in words rather than as a raw enum. */
const REVEAL_TEXT: Record<string, string> = {
  pending: "not open yet",
  open: "open — waiting for the reveal",
  revealed: "revealed",
  missed: "missed the reveal window",
  invalid: "the reveal did not check out",
};

function revealWord(status: string): string {
  return REVEAL_TEXT[status] ?? status.replace(/_/g, " ");
}

/** The public outcome in words. */
const OUTCOME_TEXT: Record<string, string> = {
  win: "win",
  loss: "loss",
  void: "void",
  oracle_unavailable: "no outcome",
};

function outcomeWord(outcome: string | null | undefined): string {
  return outcome ? (OUTCOME_TEXT[outcome] ?? outcome.replace(/_/g, " ")) : "—";
}

/** An unresolved call's state in words; "open" is only for the pending set. */
const STATE_TEXT: Record<string, string> = {
  rejected: "rejected",
  invalid_reveal: "bad reveal",
  missed_reveal: "missed reveal",
  disputed: "under dispute",
};

function callStateWord(status: string): string {
  if (isPendingCallStatus(status)) return "open";
  if (isTerminalFailureStatus(status)) return STATE_TEXT[status] ?? "failed";
  return STATE_TEXT[status] ?? status.replace(/_/g, " ");
}

function ExplorerLink({
  address,
  chainId,
  kind,
}: {
  address: string;
  chainId: number | string;
  kind: "address" | "tx";
}) {
  const id = typeof chainId === "number" ? chainId : Number(chainId);
  let base: string | null = null;
  if (id === 8453) base = "https://basescan.org";
  else if (id === 421614) base = "https://sepolia.arbiscan.io";
  if (!base) {
    return <span className="ck-mono ck-pos break-all">{address}</span>;
  }
  return (
    <a
      href={`${base}/${kind}/${address}`}
      target="_blank"
      rel="noreferrer"
      className="ck-mono ck-pos no-underline hover:underline underline-offset-2 break-all"
      title={`${address} on ${humanChain(id)}`}
    >
      {shortId(address, 10, 8)}
    </a>
  );
}
