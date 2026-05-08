import type { AgentCallRow } from "../../api.js";

interface CalmCallListProps {
  calls: AgentCallRow[];
  title?: string;
}

/**
 * Calls as a vertical reading list — one entry per row, hairline
 * separators between only. No grid lines, no monospace. Time on
 * the left, asset+side+horizon mid, signed return on the right.
 * Hover dims to 0.65 opacity.
 */
export function CalmCallList({ calls, title = "Recent calls" }: CalmCallListProps) {
  return (
    <section>
      <header className="flex items-baseline justify-between mb-10">
        <h2 className="calm-headline-sm">{title}</h2>
        <span className="calm-meta">
          {calls.length} {calls.length === 1 ? "entry" : "entries"}
        </span>
      </header>
      {calls.length === 0 ? (
        <p className="calm-body">No calls yet.</p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {calls.map((c) => (
            <li key={c.call_id} className="m-0 p-0">
              <a
                href={`#/calls/${c.call_id}`}
                className="calm-row grid-cols-[140px_1fr_140px] md:grid-cols-[180px_1fr_160px] gap-6"
              >
                <span className="calm-meta">{formatTs(c.submitted_at ?? c.accepted_at)}</span>
                <span className="flex items-baseline gap-3 flex-wrap min-w-0">
                  <span className="calm-headline-sm" style={{ fontSize: "20px" }}>
                    {formatTitle(c)}
                  </span>
                  <span className="calm-meta">{formatHorizon(c)}</span>
                </span>
                <span className="calm-stat-sm text-right tabular-nums">
                  {formatOutcome(c)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTitle(c: AgentCallRow): string {
  const scrubbed = c.privacy_mode === "committed" && c.side === undefined;
  if (scrubbed) return "Sealed commit";
  const asset = c.asset_id?.split(":").pop() ?? c.asset_id ?? "—";
  const side = c.side ?? "—";
  return `${side.toLowerCase()} ${asset}`;
}

function formatHorizon(c: AgentCallRow): string {
  if (c.privacy_mode === "committed" && c.side === undefined) return "horizon hidden";
  const h = c.horizon_hours;
  const conf = c.confidence;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (typeof conf === "number") parts.push(`${(conf * 100).toFixed(0)}% conf`);
  return parts.join(" · ");
}

function formatOutcome(c: AgentCallRow): string {
  if (!c.outcome) return "pending";
  if (c.outcome === "void") return "void";
  if (typeof c.call_score === "number") {
    const sign = c.call_score >= 0 ? "+" : "−";
    return `${sign}${Math.abs(c.call_score).toFixed(3)}`;
  }
  return c.outcome;
}
