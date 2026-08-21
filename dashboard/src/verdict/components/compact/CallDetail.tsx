import { useEffect, useState } from "react";
import { verdictApi, ApiError, type FullCall } from "../../api.js";
import { Ik } from "../../icons.js";
import { Panel } from "./Panel.js";
import { ErrorState } from "./ErrorState.js";
import { PanelSkeleton } from "./PanelSkeleton.js";
import { PrivacyTierBadge } from "../PrivacyTierBadge.js";
import { SideGlyph } from "./glyphs.js";
import { TimeAgo } from "./TimeAgo.js";
import { formatScore } from "../../lib/score-format.js";
import { shortId } from "../../lib/display-format.js";

/**
 * Shared call-detail body — the 3-stat header + submission / anchor·resolution
 * / identity-evidence panels. Fetches by `callId` and owns its own
 * loading / error / not-found states.
 *
 * Rendered in two places, so it lives here rather than inside CallPage:
 *   · variant="page"   — the full #/calls/:id route (3-column grid on ≥lg)
 *   · variant="drawer" — the in-context call drawer (always stacked, narrow)
 *
 * The layout is the ONLY thing the variant changes; the data, states, and
 * field rows are identical, so the page and the drawer can never drift.
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

  useEffect(() => {
    let cancel = false;
    setData(null);
    setError(null);
    setNotFound(false);
    verdictApi
      .call(callId)
      .then((r) => {
        if (!cancel) setData(r);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      });
    return () => {
      cancel = true;
    };
  }, [callId]);

  // Pending calls are sealed; only the privacy-mode label and public
  // resolution data are shown after scoring.
  //
  // The tooltip below states the guarantee precisely rather than the flat
  // "murmur never sees the sealed prediction" it used to claim. That was true
  // of the client-sealed path only — on /seal the operator IS handed the
  // plaintext — and it ignored that early decrypt access rests on grantor key
  // custody. The same overclaim was corrected in the agent card, README,
  // OpenAPI and skill doc; this was the copy actual users read.
  const subjectLabel = !data ? "" : "sealed";
  const outcomeText = !data
    ? ""
    : data.resolution
      ? outcomeWord(data.resolution.outcome)
      : "pending";
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
  const wrap = page
    ? "flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] min-h-0"
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
            <Stat
              label="privacy"
              value={subjectLabel}
              mono
              title="The call is sealed. Murmur cannot show it here, and the contract cannot publish it before the market's reveal time. On the standard path the agent seals the call in its own runtime, so murmur never holds the plain text. On the optional /seal path murmur does hold it, by design."
            />
            <Stat label="outcome" value={outcomeText} tone={outcomeTone} />
            <Stat
              label="score"
              value={formatScore(data.resolution?.call_score, { decimals: 4 })}
              mono
              title="How good this call was. It pays the agent for being right and confident, and charges it for being wrong and confident."
            />
          </div>

          <Panel
            title={
              <>
                <Ik name="verdict" /> the call
              </>
            }
            className={panelCls}
          >
            <Kv
              k="call id"
              v={
                <span title={data.submission.call_id}>
                  {shortId(data.submission.call_id, 8, 5)}
                </span>
              }
              mono
            />
            <Kv
              k="agent id"
              v={
                <span title={data.submission.agent_id}>
                  {shortId(data.submission.agent_id, 8, 5)}
                </span>
              }
              mono
            />
            {data.submission.privacy_mode && (
              <div className="flex items-center justify-between px-2 py-1">
                <span className="ck-label ck-dim">privacy</span>
                <PrivacyTierBadge mode={data.submission.privacy_mode} />
              </div>
            )}
            {data.submission.commit_hash && (
              <Kv
                k="commit hash"
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
                    {/* Glyph + word, the same grammar the sealed branch below
                        uses ("seal glyph + sealed"). Without the word the two
                        states of this one row speak different languages: an
                        arrow alone, then a marked-up phrase. */}
                    <Kv
                      k="side"
                      v={
                        <span className="inline-flex items-center gap-1">
                          <SideGlyph
                            side={data.fhenix.revealed_verdict.binary_index === 0 ? "UP" : "DOWN"}
                          />
                          {data.fhenix.revealed_verdict.binary_index === 0 ? "up" : "down"}
                        </span>
                      }
                    />
                    <Kv
                      k="confidence"
                      v={`${(data.fhenix.revealed_verdict.confidence_bps / 100).toFixed(2)}%`}
                    />
                  </>
                ) : (
                  <>
                    <Kv k="side" v="sealed" tone="ck-dim" />
                    <Kv k="confidence" v="sealed" tone="ck-dim" />
                  </>
                )}
              </>
            )}
            {data.submission.submitted_at && (
              <Kv
                k="sent"
                v={<TimeAgo iso={data.submission.submitted_at} />}
                title="when the agent sent this call"
              />
            )}
            <Kv
              k="accepted"
              v={<TimeAgo iso={data.submission.accepted_at} />}
              title="when murmur accepted the call and sealed it"
            />
            {data.submission.strategy_tag && (
              <Kv k="strategy" v={data.submission.strategy_tag} />
            )}
          </Panel>

          <Panel
            title={
              <>
                <Ik name="resolve" /> resolution
              </>
            }
            className={panelCls}
          >
            {/* PRICE-ANCHOR ROWS — legacy native-price calls only.
                Murmur is a pure referee on external venues: a venue call has no
                anchor, no anchor price and no price feed, so the old
                "t0: awaiting anchor" placeholder promised machinery that is
                never coming for it. The whole block is gated on the data now,
                and the empty branch is gone. */}
            {data.t0 && (
              <>
                <Kv
                  k="anchor time"
                  v={<TimeAgo iso={data.t0.t0} />}
                  title="when the price was read at the start of this call"
                />
                <Kv
                  k="anchor price"
                  v={data.t0.p0}
                  title="the starting price this call is measured from"
                />
                <Kv
                  k="price source"
                  v={data.t0.feed}
                  title="the price feed that gave the anchor price"
                />
                <KvDivider />
              </>
            )}
            {data.resolution ? (
              <>
                <Kv
                  k="market closed"
                  v={<TimeAgo iso={data.resolution.t1} />}
                  title="when the market closed and the call became scorable"
                />
                {/* Same rule as the anchor block: a venue call carries no
                    closing price and no feed, so the rows only appear when the
                    daemon actually has them. */}
                {data.resolution.p1 !== null && data.resolution.p1 !== undefined && (
                  <Kv
                    k="closing price"
                    v={data.resolution.p1}
                    title="the closing price, compared against the anchor price to score the call"
                  />
                )}
                {data.resolution.t1_feed !== null && data.resolution.t1_feed !== undefined && (
                  <Kv
                    k="price source"
                    v={data.resolution.t1_feed}
                    title="the price feed that gave the closing price"
                  />
                )}
                {data.resolution.call_score !== null && (
                  <Kv
                    k="score"
                    v={formatScore(data.resolution.call_score, { decimals: 4 })}
                    title="How good this call was. It pays the agent for being right and confident, and charges it for being wrong and confident."
                  />
                )}
                <Kv
                  k="scored"
                  v={<TimeAgo iso={data.resolution.resolved_at} />}
                  title="when murmur scored this call"
                />
              </>
            ) : (
              <Kv
                k="scored"
                v="not yet — the market has not settled"
                tone="ck-dim"
              />
            )}
          </Panel>

          <Panel
            title={
              <>
                <Ik name="seal" /> on-chain proof
              </>
            }
            className={page ? undefined : "-mt-px"}
          >
            {data.fhenix ? (
              <>
                <Kv
                  k="chain"
                  v={humanChain(data.fhenix.chain_id)}
                  title={String(data.fhenix.chain_id)}
                />
                <Kv
                  k="contract"
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
                  k="on-chain call id"
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
                  k="reveal"
                  v={revealWord(data.fhenix.reveal_status)}
                  tone={revealTone(data.fhenix.reveal_status)}
                  title="whether the sealed call has been opened yet"
                />
                <Kv
                  k="reveal opens"
                  v={<TimeAgo iso={data.fhenix.reveal_open_at} />}
                  tone="ck-dim"
                  title="the earliest moment this call can be opened"
                />
                {data.fhenix.revealed_at && (
                  <Kv k="revealed" v={<TimeAgo iso={data.fhenix.revealed_at} />} />
                )}
                {data.fhenix.terminal_at && (
                  <Kv
                    k="closed"
                    v={<TimeAgo iso={data.fhenix.terminal_at} />}
                    tone="ck-dim"
                    title="when this call reached its final state on chain"
                  />
                )}
                {data.fhenix.invalid_reason && (
                  <Kv k="why it failed" v={data.fhenix.invalid_reason} tone="ck-neg" />
                )}
              </>
            ) : (
              <Kv k="on-chain" v="this call is not on chain yet" tone="ck-dim" />
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
  if (id === 84532) return "base sepolia";
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

/**
 * The public outcome, said in words. `oracle_unavailable` is the one that has
 * to change: it names retired price-feed machinery, and what actually happened
 * is that no outcome landed for this call.
 */
const OUTCOME_TEXT: Record<string, string> = {
  win: "win",
  loss: "loss",
  void: "void",
  oracle_unavailable: "no outcome",
};

function outcomeWord(outcome: string | null | undefined): string {
  if (!outcome) return "pending";
  return OUTCOME_TEXT[outcome] ?? outcome.replace(/_/g, " ");
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
  else if (id === 84532) base = "https://sepolia.basescan.org";
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
