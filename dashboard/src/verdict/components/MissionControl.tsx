import { useStream, type CallAcceptedEvent, type CallResolvedEvent } from "../hooks/useStream.js";
import { OutcomeChip } from "./OutcomeChip.js";
import { side as sideTokens } from "../ui/tokens.js";

/**
 * Two-column live state panel modeled on Cursor's "Mission Control".
 * Left = pending calls in flight, right = recently resolved. Cards move
 * between columns when call.resolved fires; the transform IS the signal.
 *
 * No spring physics, no bounce — Nothing's "percussive, not fluid" rule.
 * A 200ms ease-out is enough to make the swap legible without being decorative.
 */
export function MissionControl() {
  const stream = useStream();
  const accepted = stream.recentCalls.filter(isAccepted);
  const resolved = stream.recentCalls.filter(isResolved);

  const pending = dedupeAccepted(accepted, resolved);

  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-px bg-[var(--color-border)] border-y border-[var(--color-border)]">
      <Column title="PENDING" subtitle="in flight">
        {pending.length === 0 && <Empty label="awaiting next call" />}
        {pending.slice(0, 5).map((event) => (
          <PendingCard key={event.call_id} event={event} />
        ))}
      </Column>
      <Column title="RESOLVED" subtitle="last 5">
        {resolved.length === 0 && <Empty label="nothing settled yet" />}
        {resolved.slice(0, 5).map((event) => (
          <ResolvedCard key={event.call_id} event={event} />
        ))}
      </Column>
    </section>
  );
}

function Column({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--color-bg)] flex flex-col">
      <div className="px-6 py-3 flex items-baseline justify-between border-b border-[var(--color-border)]">
        <span className="t-label">{title}</span>
        <span className="t-meta text-[var(--color-disabled)]">{subtitle}</span>
      </div>
      <ol className="m-0 p-0 list-none">{children}</ol>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <li className="px-6 py-12 t-meta text-[var(--color-disabled)]">[ {label} ]</li>
  );
}

function PendingCard({ event }: { event: CallAcceptedEvent }) {
  return (
    <li className="border-b border-[var(--color-border)]">
      <a
        href={`#/calls/${event.call_id}`}
        className="block px-6 py-4 no-underline press-feedback hover:bg-[white]/[0.02]"
      >
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <span className="t-subheading text-[var(--color-display)] truncate">
            {event.agent_slug}
          </span>
          <span className="inline-block w-[5px] h-[5px] bg-[var(--color-accent)] nothing-live" />
        </div>
        <div className="flex items-center gap-3 t-data text-[var(--color-secondary)]">
          <span className={event.side === "SELL" ? sideTokens.sell : sideTokens.buy}>
            {event.side}
          </span>
          <span className="text-[var(--color-display)]">
            {event.asset_id.split(":").pop() ?? event.asset_id}
          </span>
          <span>{event.horizon_hours}H</span>
          <span>{(event.confidence * 100).toFixed(0)}%</span>
        </div>
      </a>
    </li>
  );
}

function ResolvedCard({ event }: { event: CallResolvedEvent }) {
  const ret = event.signed_return ? Number(event.signed_return) : null;
  return (
    <li className="border-b border-[var(--color-border)]">
      <a
        href={`#/calls/${event.call_id}`}
        className="block px-6 py-4 no-underline press-feedback hover:bg-[white]/[0.02]"
      >
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <span className="t-subheading text-[var(--color-display)] truncate">
            {event.agent_slug}
          </span>
          <OutcomeChip outcome={event.outcome}>
            {event.call_score !== null
              ? `${event.call_score >= 0 ? "+" : ""}${event.call_score.toFixed(3)}`
              : event.outcome.toUpperCase()}
          </OutcomeChip>
        </div>
        <div className="flex items-center gap-3 t-data text-[var(--color-secondary)]">
          <span
            className={
              ret !== null && ret >= 0
                ? "text-[var(--color-display)]"
                : "text-[var(--color-accent)]"
            }
          >
            {ret !== null ? `${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(2)}%` : "—"}
          </span>
          <span className="text-[var(--color-disabled)]">
            {event.resolved_at.slice(11, 19)}
          </span>
        </div>
      </a>
    </li>
  );
}

function isAccepted(e: CallAcceptedEvent | CallResolvedEvent): e is CallAcceptedEvent {
  return e.type === "call.accepted";
}
function isResolved(e: CallAcceptedEvent | CallResolvedEvent): e is CallResolvedEvent {
  return e.type === "call.resolved";
}

/** Drop accepted events that already have a resolved twin in this buffer. */
function dedupeAccepted(
  accepted: CallAcceptedEvent[],
  resolved: CallResolvedEvent[],
): CallAcceptedEvent[] {
  const settled = new Set(resolved.map((r) => r.call_id));
  return accepted.filter((a) => !settled.has(a.call_id));
}
