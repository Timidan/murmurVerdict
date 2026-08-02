import { useEffect, useState } from "react";
import { verdictApi, ApiError, type FullCall } from "../../api.js";
import { Panel } from "./Panel.js";
import { ErrorState } from "./ErrorState.js";
import { PanelSkeleton } from "./PanelSkeleton.js";
import { PrivacyTierBadge } from "../PrivacyTierBadge.js";
import { SideGlyph } from "./glyphs.js";
import { formatScore } from "../../lib/score-format.js";

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
  const subjectLabel = !data ? "" : "operator-blind";
  const outcomeText = !data ? "" : data.resolution ? data.resolution.outcome : "pend";
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
              label="subject"
              value={subjectLabel}
              mono
              title="operator-blind — murmur never sees the sealed prediction; only the agent's plaintext is revealed after the horizon closes"
            />
            <Stat label="outcome" value={outcomeText} tone={outcomeTone} />
            <Stat
              label="score"
              value={formatScore(data.resolution?.call_score, { decimals: 4 })}
              mono
              title="call_score — Brier-style skill term for this resolved call"
            />
          </div>

          <Panel title="submission" className={panelCls}>
            <Kv k="call_id" v={data.submission.call_id} mono />
            <Kv k="agent_id" v={data.submission.agent_id} mono />
            {data.submission.privacy_mode && (
              <div className="flex items-center justify-between px-2 py-1">
                <span className="ck-label ck-dim">privacy_mode</span>
                <PrivacyTierBadge mode={data.submission.privacy_mode} />
              </div>
            )}
            {data.submission.commit_hash && (
              <Kv k="commit_hash" v={data.submission.commit_hash} mono />
            )}
            {data.fhenix && (
              <>
                {data.fhenix.revealed_verdict ? (
                  <>
                    <Kv
                      k="side"
                      v={
                        <SideGlyph
                          side={data.fhenix.revealed_verdict.binary_index === 0 ? "UP" : "DOWN"}
                        />
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
              <Kv k="submitted_at" v={data.submission.submitted_at} />
            )}
            <Kv k="accepted_at" v={data.submission.accepted_at} />
            {data.submission.strategy_tag && (
              <Kv k="strategy_tag" v={data.submission.strategy_tag} />
            )}
          </Panel>

          <Panel title="anchor · resolution" className={panelCls}>
            {data.t0 ? (
              <>
                <Kv
                  k="t0"
                  v={data.t0.t0}
                  title="anchor open — timestamp the oracle price was observed when the call opened"
                />
                <Kv
                  k="p0"
                  v={data.t0.p0}
                  title="anchor price — oracle price at t0, the baseline the return is measured from"
                />
                <Kv
                  k="t0_feed"
                  v={data.t0.feed}
                  title="oracle feed that supplied the t0 anchor price (e.g. chainlink:base:ETH-USD)"
                />
              </>
            ) : (
              <Kv k="t0" v="awaiting anchor" tone="ck-dim" />
            )}
            <KvDivider />
            {data.resolution ? (
              <>
                <Kv
                  k="t1"
                  v={data.resolution.t1}
                  title="resolution time — horizon-close timestamp the call was settled at"
                />
                <Kv
                  k="p1"
                  v={data.resolution.p1 ?? "—"}
                  title="resolution price — oracle price at t1, compared against p0 to score the call (native-price only)"
                />
                <Kv
                  k="t1_feed"
                  v={data.resolution.t1_feed ?? "—"}
                  title="oracle feed that supplied the t1 resolution price (native-price only)"
                />
                {data.resolution.call_score !== null && (
                  <Kv
                    k="call_score"
                    v={formatScore(data.resolution.call_score, { decimals: 4 })}
                    title="call_score — Brier-style skill term for this resolved call"
                  />
                )}
                <Kv k="resolved_at" v={data.resolution.resolved_at} />
              </>
            ) : (
              <Kv k="t1" v="awaiting resolution" tone="ck-dim" />
            )}
          </Panel>

          <Panel title="identity evidence" className={page ? undefined : "-mt-px"}>
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
                  k="onchain_call_id"
                  v={
                    <span className="ck-mono ck-pos break-all">
                      {data.fhenix.onchain_call_id}
                    </span>
                  }
                  mono
                  title="on-chain sealed-call id emitted by the Fhenix gateway contract when the verdict was sealed"
                />
                <KvDivider />
                <Kv
                  k="reveal_status"
                  v={data.fhenix.reveal_status}
                  tone={revealTone(data.fhenix.reveal_status)}
                />
                <Kv k="reveal_open_at" v={data.fhenix.reveal_open_at} tone="ck-dim" />
                {data.fhenix.revealed_at && (
                  <Kv k="revealed_at" v={data.fhenix.revealed_at} />
                )}
                {data.fhenix.terminal_at && (
                  <Kv k="terminal_at" v={data.fhenix.terminal_at} tone="ck-dim" />
                )}
                {data.fhenix.invalid_reason && (
                  <Kv k="invalid_reason" v={data.fhenix.invalid_reason} tone="ck-neg" />
                )}
              </>
            ) : (
              <Kv k="fhenix" v="no sealed-call binding" tone="ck-dim" />
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
      {address.slice(0, 10)}…{address.slice(-8)}
    </a>
  );
}
