import type { AgentCallRow } from "../api.js";
import { OutcomeChip } from "./OutcomeChip.js";
import { side as sideTokens } from "../ui/tokens.js";

interface CallLogProps {
  title?: string;
  calls: AgentCallRow[];
  /** When true, each row exposes a per-row [V] verify affordance.
   *  Per V14_HANDOFF §11: verify is row-level, never page-level. */
  verifyAffordance?: boolean;
}

const COLUMNS = "grid-cols-[110px_70px_60px_90px_1fr_100px]";

/**
 * Terminal-style log of an agent's recent calls. Hairline rows, no fill.
 * Columns: timestamp | side | asset | horizon · conf | note | outcome.
 * No zebra, no shadows. Hover lifts row to a 2% white film.
 */
export function CallLog({ title = "RECENT CALLS", calls, verifyAffordance = true }: CallLogProps) {
  return (
    <section className="border-y border-[var(--color-border)]">
      <div className="px-6 py-3 flex items-baseline justify-between">
        <span className="t-label">{title}</span>
        <span className="t-meta text-[var(--color-disabled)]">
          {calls.length} {calls.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      {calls.length === 0 ? (
        <div className="px-6 py-12 t-body-sm text-[var(--color-disabled)]">
          [no calls yet]
        </div>
      ) : (
        <div role="table" aria-label={title}>
          <div
            role="row"
            className={`grid ${COLUMNS} gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]`}
          >
            <span role="columnheader">timestamp</span>
            <span role="columnheader">side</span>
            <span role="columnheader">asset</span>
            <span role="columnheader">horizon</span>
            <span role="columnheader">note</span>
            <span role="columnheader" className="text-right">outcome</span>
          </div>
          {calls.map((c) => (
            <CallRow key={c.call_id} call={c} verifyAffordance={verifyAffordance} />
          ))}
        </div>
      )}
    </section>
  );
}

function CallRow({ call, verifyAffordance }: { call: AgentCallRow; verifyAffordance: boolean }) {
  const ts = formatTs(call.submitted_at);
  const isSell = call.side === "SELL";
  const horizon = `${call.horizon_hours}H · ${(call.confidence * 100).toFixed(0)}%`;
  const note = formatNote(call);

  return (
    <a
      role="row"
      href={`#/calls/${call.call_id}`}
      className={
        `grid ${COLUMNS} gap-4 px-6 py-3 items-center ` +
        "border-t border-[var(--color-border)] no-underline " +
        "hover:bg-[white]/[0.02] press-feedback " +
        "transition-colors duration-150 ease-out group"
      }
    >
      <span role="cell" className="t-data text-[var(--color-secondary)]">{ts}</span>
      <span role="cell" className={`t-button ${isSell ? sideTokens.sell : sideTokens.buy}`}>
        {call.side}
      </span>
      <span role="cell" className="t-data text-[var(--color-display)]">
        {call.asset_id.split(":").pop() ?? call.asset_id}
      </span>
      <span role="cell" className="t-data text-[var(--color-secondary)]">{horizon}</span>
      <span role="cell" className="t-body-sm truncate">{note}</span>
      <span role="cell" className="text-right flex items-center justify-end gap-2">
        <OutcomeChip outcome={call.outcome ?? "live"}>
          {formatOutcomeLabel(call)}
        </OutcomeChip>
        {verifyAffordance && (
          <span
            className={
              "t-meta text-[var(--color-disabled)] " +
              "opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            }
            aria-hidden
          >
            [V]
          </span>
        )}
      </span>
    </a>
  );
}

function formatTs(iso: string): string {
  // Today: HH:MM:SS · Older: MM-DD·HH:MM
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toISOString().slice(11, 19);
  }
  return iso.slice(5, 10).replace("-", "-") + "·" + iso.slice(11, 16);
}

function formatNote(c: AgentCallRow): string {
  if (!c.outcome && !c.signed_return) return "acceptance";
  if (c.outcome === "void") return "inside void band · ±0%";
  if (c.signed_return) {
    const pct = (Number(c.signed_return) * 100).toFixed(2);
    const sign = pct.startsWith("-") ? "" : "+";
    return `resolved · ${sign}${pct}%`;
  }
  return c.outcome ?? "—";
}

function formatOutcomeLabel(c: AgentCallRow): string {
  if (!c.outcome) return "PEND";
  if (c.outcome === "win" && c.call_score !== null && c.call_score !== undefined) {
    return `+${c.call_score.toFixed(3)}`;
  }
  if (c.outcome === "loss" && c.call_score !== null && c.call_score !== undefined) {
    return c.call_score < 0 ? c.call_score.toFixed(3) : `−${c.call_score.toFixed(3)}`;
  }
  return c.outcome.toUpperCase();
}
