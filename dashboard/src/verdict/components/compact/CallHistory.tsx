import { Fragment, useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { AgentCallRow } from "../../api.js";
import { Ik } from "../../icons.js";
import {
  classifyCallOutcome,
  isPendingCallStatus,
  isTerminalFailureStatus,
} from "@shared/wire-call-status";
import {
  formatLocalDateTime,
  formatLocalDayLabel,
  localDayKey,
} from "../../lib/date-time-format.js";
import { sentenceCase, shortId } from "../../lib/display-format.js";
import { formatScore } from "../../lib/score-format.js";
import { isPlainLeftClick, useDetailDrawer } from "./DetailDrawer.js";

/**
 * Call history, told by the day instead of listed flat.
 *
 * A hundred calls in one column is a wall: every row is the same shape, so the
 * eye has nothing to hold and the reader learns nothing they could not have
 * learnt from the first three rows. This splits the same data in two:
 *
 *   · `all · summary` — one strip per day. How many calls, how many wins, how
 *     many losses, the day's average score. No individual calls. This is the
 *     story, and it is what the panel opens on.
 *   · one tab per day — the calls themselves, newest first, ten at a time, with
 *     the rest one button away. Each row is a real link to its call page; the
 *     `ⓘ` beside it opens the depth (full id, market, seal + score times, what
 *     the agent called, the outcome, the score and why it is that number).
 *
 * Days are the READER's days: the key comes from the viewer's own zone (see
 * lib/date-time-format), never from UTC, so a call made at 11pm local never
 * lands on tomorrow's tab.
 *
 * RIGHT IS GREEN (owner ruling, 2026-08-10). The tone follows the OUTCOME, not
 * the sign of the number: on the venue path a call score runs 0…1, where +1.00
 * means the call was right and confident and +0.00 means it was wrong and
 * confident — colouring by sign would paint every row green and say nothing.
 * The words carry the meaning either way ("win" / "loss" sit in the row, in
 * the tooltip and in the accessible name); the colour only reinforces them.
 *
 * Hit areas: rows keep the cockpit's density (~32px) rather than the 40px a
 * standalone control gets. The whole row IS the link (`ck-rowlink`, inset 0),
 * so the target is a full-width 32px band; the tabs above are ordinary controls
 * and take the app's 40px tab target (matching the markets matrix).
 */

/** Rows a day tab shows before the reader asks for the rest. */
const DAY_PAGE = 10;

/** Day tabs the strip shows before the reader asks for the rest. */
const DAY_TABS = 7;

/** The tab that tells the story rather than listing the calls. */
const SUMMARY_TAB = "all";

/**
 * The outcome, in the app's one set of words for it.
 *
 * This surface used to say "right" and "wrong" while the ladder said "win" and
 * the summary panel said "won", so one fact wore three names on three screens
 * a click apart. COPY.md rule 5 is "one word, one meaning, everywhere", and the
 * word the wire, the ladder, the call page and the leaderboard all already use
 * is `win` / `loss`. The sentence under a score still explains what winning
 * cost or paid; it just no longer introduces a second vocabulary to do it.
 * `oracle_unavailable` names retired price-feed machinery; a reader needs to
 * know only that no outcome landed.
 */
const OUTCOME_WORD: Record<string, string> = {
  win: "win",
  loss: "loss",
  void: "void",
  oracle_unavailable: "no outcome",
};

interface DayBucket {
  /** Sortable local-day key, `2026-07-20`. Empty for an unparseable stamp. */
  key: string;
  /** Short local label, `jul 20`. */
  label: string;
  calls: AgentCallRow[];
  wins: number;
  losses: number;
  /** Calls that finished with a win or a loss AND carry a score. */
  scored: number;
  scoreSum: number;
}

/** The instant a call belongs to — the same one the row used to print. */
function callInstant(c: AgentCallRow): string {
  return c.submitted_at ?? c.accepted_at;
}

/**
 * What a call without a settled outcome is called. "open" belongs to the
 * canonical pending set alone (COPY.md: sealed, not resolved yet) — a rejected
 * call, a bad reveal and a missed reveal are terminal and will never resolve,
 * so labelling all three "open" told the reader to keep waiting for a verdict
 * that is not coming.
 */
const STATE_WORD: Record<string, string> = {
  rejected: "rejected",
  invalid_reveal: "bad reveal",
  missed_reveal: "missed reveal",
  disputed: "under dispute",
};

function outcomeWord(c: AgentCallRow): string {
  if (c.outcome) return OUTCOME_WORD[c.outcome] ?? c.outcome.replace(/_/g, " ");
  if (isPendingCallStatus(c.status)) return "open";
  if (isTerminalFailureStatus(c.status)) return STATE_WORD[c.status] ?? "failed";
  return STATE_WORD[c.status] ?? c.status.replace(/_/g, " ");
}

/** Ink for a call's score. Keyed on the outcome — see the header note. */
function outcomeTone(c: AgentCallRow): string {
  const outcome = classifyCallOutcome(c.outcome);
  if (outcome === "win") return "text-[var(--color-success)]";
  if (outcome === "loss") return "ck-neg";
  return "ck-dim";
}

function groupByLocalDay(calls: AgentCallRow[]): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  for (const c of calls) {
    const iso = callInstant(c);
    const key = localDayKey(iso) ?? "";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        // A stamp we cannot parse keeps its calls under a named tab rather than
        // dropping them out of the history altogether.
        label: (key === "" ? null : formatLocalDayLabel(iso)) ?? "undated",
        calls: [],
        wins: 0,
        losses: 0,
        scored: 0,
        scoreSum: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.calls.push(c);
    const outcome = classifyCallOutcome(c.outcome);
    if (outcome === "win") bucket.wins++;
    else if (outcome === "loss") bucket.losses++;
    if (
      (outcome === "win" || outcome === "loss") &&
      c.call_score !== null &&
      c.call_score !== undefined
    ) {
      bucket.scored++;
      bucket.scoreSum += c.call_score;
    }
  }
  // Newest day first. The undated bucket sorts last: "" is below every key.
  return [...buckets.values()].sort((a, b) =>
    a.key < b.key ? 1 : a.key > b.key ? -1 : 0,
  );
}

export function CallHistory({ calls }: { calls: AgentCallRow[] }) {
  const days = useMemo(() => groupByLocalDay(calls), [calls]);
  const [tab, setTab] = useState<string>(SUMMARY_TAB);
  const [allDays, setAllDays] = useState(false);
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // A refetch can retire the day a reader is standing on. Fall back to the
  // story view rather than painting an empty tab.
  const active = days.some((d) => d.key === tab) ? tab : SUMMARY_TAB;
  const day = days.find((d) => d.key === active) ?? null;

  // Days are capped the way a day's rows are: one batch of calls spread over a
  // quiet deployment is one tab per call, and fifty wrapping tabs are not a
  // navigation. The day being read stays in the strip even when it sits past
  // the cap, so the selection can never point at a tab that is not there.
  const visibleDays = useMemo(() => {
    if (allDays || days.length <= DAY_TABS) return days;
    const head = days.slice(0, DAY_TABS);
    const current = days.find((d) => d.key === active);
    return current && !head.includes(current) ? [...head, current] : head;
  }, [days, allDays, active]);
  const restDays = days.length - visibleDays.length;

  if (days.length === 0) {
    return <div className="px-2 py-2 ck-mono ck-dim">[no calls yet]</div>;
  }

  return (
    <div className="flex flex-col min-h-0">
      {/* In-panel tabs, the app's own idiom: buttons carrying `ck-tab` +
          aria-pressed (LaunchPage's integration tabs), at the 40px target the
          markets matrix uses for its view links. No role="tablist" — that
          contract owes a reader arrow-key navigation this does not implement. */}
      <div
        role="group"
        aria-label="call history"
        className="flex flex-wrap items-stretch border-b border-[var(--color-border)]"
      >
        <TabButton
          active={active === SUMMARY_TAB}
          onSelect={() => setTab(SUMMARY_TAB)}
        >
          All <span className="ck-dim">·</span> summary
        </TabButton>
        {visibleDays.map((d) => (
          <TabButton
            key={d.key}
            active={active === d.key}
            onSelect={() => setTab(d.key)}
          >
            {sentenceCase(d.label)} <span className="ck-dim">·</span>{" "}
            <span className="tabular-nums">{d.calls.length}</span>
          </TabButton>
        ))}
        {restDays > 0 && (
          <TabButton onSelect={() => setAllDays(true)}>
            Show {restDays} more {restDays === 1 ? "day" : "days"}
          </TabButton>
        )}
      </div>

      {day === null ? (
        <DaySummary days={visibleDays} />
      ) : (
        <DayCalls
          day={day}
          expanded={openDays.has(day.key)}
          onExpand={() =>
            setOpenDays((prev) => new Set<string>(prev).add(day.key))
          }
        />
      )}
    </div>
  );
}

/** `active` omitted means this is not one of the views: the strip's own
 *  expander borrows the tab's shape without claiming a pressed state. */
function TabButton({
  active,
  onSelect,
  children,
}: {
  active?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={
        "ck-tab ck-label inline-flex min-h-[40px] items-center px-2 " +
        "border-r border-[var(--color-border)] " +
        (active ? "ck-tab-active" : "ck-dim ck-hoverable")
      }
    >
      {children}
    </button>
  );
}

/**
 * The story view: one strip per day, no individual calls. Counts are the
 * headline — a reader who only reads this knows how the agent's week went.
 * The day's average score stays in the primary ink: on the 0…1 venue scale
 * every average is positive, so a sign-tinted number would be green forever.
 */
function DaySummary({ days }: { days: DayBucket[] }) {
  return (
    <ul className="m-0 p-0 list-none">
      {days.map((d) => {
        const avg = d.scored === 0 ? null : d.scoreSum / d.scored;
        return (
          <li
            key={d.key}
            className={
              "flex flex-wrap items-baseline gap-x-3 gap-y-1 px-2 py-1.5 " +
              "border-b border-[var(--color-border-vis)]"
            }
          >
            <span className="ck-mono ck-pos">{d.label}</span>
            <span className="ck-label tabular-nums">
              {d.calls.length === 1 ? "1 call" : `${d.calls.length} calls`}
            </span>
            <span className="ck-mono text-[var(--color-success)]">
              {d.wins === 1 ? "1 win" : `${d.wins} wins`}
            </span>
            <span className="ck-mono ck-neg">
              {d.losses === 1 ? "1 loss" : `${d.losses} losses`}
            </span>
            <span className="ml-auto ck-label">Avg score</span>
            <span
              className="ck-mono"
              title="the average score across this day's scored calls"
            >
              {formatScore(avg)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function DayCalls({
  day,
  expanded,
  onExpand,
}: {
  day: DayBucket;
  expanded: boolean;
  onExpand: () => void;
}) {
  const shown = expanded ? day.calls : day.calls.slice(0, DAY_PAGE);
  const rest = day.calls.length - shown.length;
  return (
    <>
      <ul className="m-0 p-0 list-none">
        {shown.map((c) => (
          <CallRow key={c.call_id} call={c} />
        ))}
      </ul>
      {rest > 0 && (
        <div className="px-2 py-1.5">
          <button
            type="button"
            onClick={onExpand}
            className="ck-btn ck-btn-bracket"
          >
            show {rest} more from {day.label}
          </button>
        </div>
      )}
    </>
  );
}

function CallRow({ call }: { call: AgentCallRow }) {
  const { open } = useDetailDrawer();
  const settled = classifyCallOutcome(call.outcome) !== null;
  // The glyph's spoken name follows the real state: a rejected or missed-reveal
  // call is not "sealed" and never will be scored.
  const sealWord = settled
    ? "scored"
    : isPendingCallStatus(call.status)
      ? "sealed"
      : outcomeWord(call);
  const word = outcomeWord(call);
  const tone = outcomeTone(call);
  const shortCallId = call.call_id.slice(0, 8);

  return (
    <li
      className={
        // Narrow: the market ref drops to its own line under the call. Wide:
        // one line, fixed tracks, so scores stack in a readable column.
        "relative grid min-h-[32px] items-center gap-x-1.5 gap-y-0.5 px-2 py-[3px] " +
        "grid-cols-[20px_minmax(0,1fr)_auto_auto_24px] " +
        "sm:grid-cols-[20px_84px_64px_72px_24px_minmax(0,1fr)] " +
        "border-b border-[var(--color-border)] ck-hoverable"
      }
    >
      {/* Stretched row link — a real box (unlike display:contents) so keyboard
          focus lands and the ring outlines the whole row. */}
      <a
        href={`#/calls/${call.call_id}`}
        aria-label={`call ${shortCallId} — ${word}`}
        onClick={(e) => {
          if (isPlainLeftClick(e)) {
            e.preventDefault();
            open("call", call.call_id);
          }
        }}
        className="ck-rowlink"
      />
      <span className={"inline-flex items-center " + tone} title={sealWord}>
        <Ik name={settled ? "resolve" : "seal"} />
        <span className="sr-only">{sealWord}</span>
      </span>
      <span className="ck-mono ck-pos truncate" title={call.call_id}>
        {shortCallId}
      </span>
      <span className={"ck-mono text-right " + tone}>
        {formatScore(call.call_score ?? null)}
      </span>
      <span className={"ck-label truncate " + tone}>{sentenceCase(word)}</span>
      <CallTip call={call} />
      {/* Last in the row and last in the DOM, so the narrow grid can drop it to
          its own line without stranding the tooltip on a third row. */}
      <span
        className={
          "col-span-5 sm:col-span-1 ck-mono ck-dim truncate sm:text-right"
        }
        title={call.market_id ?? undefined}
      >
        {call.market_id ? shortId(call.market_id, 9, 5) : "—"}
      </span>
    </li>
  );
}

/**
 * Per-row depth, in the FormulaTip idiom (components/compact/FormulaTip.tsx).
 * A sibling rather than a prop on that component: FormulaTip carries exactly
 * two strings (a plain sentence and a formula), and this needs a labelled block
 * of six facts. The accessibility contract is copied verbatim — tabbable
 * trigger, the whole content in `aria-label`, Escape blurs, an aria-hidden
 * panel, and the shared `formula-tip-trigger` / `formula-tip` class hooks so
 * the touch reveal (compact.css, `hover: none`) and the reduced-motion gate
 * (styles.css) apply here too.
 */
function CallTip({ call }: { call: AgentCallRow }) {
  const facts = callFacts(call);
  const scored = scoreLine(call);
  const spoken =
    `about call ${call.call_id} — ` +
    facts.map((f) => `${f.label}: ${f.value}`).join(". ") +
    `. score: ${scored}`;

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <span
      tabIndex={0}
      aria-label={spoken}
      onKeyDown={onKeyDown}
      onClick={
        // Safari only treats a non-form element as tappable-focusable when it
        // carries a click handler; the emptiness is the point — focus is the
        // mechanism, and it must not reach the row link underneath.
        (event) => event.stopPropagation()
      }
      className={
        // relative z-[1] lifts the trigger above the row's stretched link.
        "formula-tip-trigger relative z-[1] " +
        "inline-flex min-h-[32px] cursor-help items-center justify-self-end " +
        "[&:hover_.formula-tip]:translate-y-0 [&:hover_.formula-tip]:opacity-100 " +
        "[&:focus-visible_.formula-tip]:translate-y-0 [&:focus-visible_.formula-tip]:opacity-100"
      }
    >
      <span aria-hidden="true" className="ck-dim text-[12px] leading-none">
        ⓘ
      </span>
      <span
        aria-hidden="true"
        className={
          "formula-tip pointer-events-none absolute right-0 top-full z-50 mt-1 " +
          "w-max max-w-[260px] translate-y-1 border border-[var(--color-border-vis)] " +
          "bg-[var(--color-raised)] px-2 py-1 text-[12px] leading-snug " +
          "text-[var(--color-primary)] opacity-0 transition-[opacity,transform] " +
          "duration-[140ms] ease-out"
        }
      >
        <span className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2">
          {facts.map((f) => (
            <Fragment key={f.label}>
              <span className="ck-dim">{f.label}</span>
              <span className="break-all">{f.value}</span>
            </Fragment>
          ))}
        </span>
        <span className="mt-1 block">{scored}</span>
      </span>
    </span>
  );
}

interface Fact {
  label: string;
  value: string;
}

/**
 * What the tooltip states. Every value is a field the agent-calls wire actually
 * carries — there is no market question and no window boundary on it, so the
 * market shows its ref and the timing shows the two instants murmur recorded.
 */
function callFacts(call: AgentCallRow): Fact[] {
  return [
    { label: "call", value: call.call_id },
    { label: "market", value: call.market_id ?? "not recorded on this call" },
    {
      label: "sealed",
      value: formatLocalDateTime(callInstant(call)) ?? "not recorded",
    },
    {
      label: "scored",
      value:
        formatLocalDateTime(call.resolved_at ?? null) ??
        "not yet — the market has not settled",
    },
    { label: "called", value: describeCall(call) },
    { label: "outcome", value: outcomeWord(call) },
  ];
}

/**
 * What the agent called, when the wire carries it. Sealed calls carry neither
 * side nor confidence by design, so this says so instead of printing a blank.
 */
function describeCall(call: AgentCallRow): string {
  const side = call.side ? call.side.toLowerCase() : null;
  const confidence =
    typeof call.confidence === "number" &&
    call.confidence >= 0 &&
    call.confidence <= 1
      ? `${Math.round(call.confidence * 100)}% confident`
      : null;
  if (side && confidence) return `${side}, ${confidence}`;
  if (side) return side;
  if (confidence) return confidence;
  if (classifyCallOutcome(call.outcome) === null) return "sealed until the reveal";
  return "sealed here — open the call page for the reveal";
}

/** The score, and the one line that says why it is that number. */
function scoreLine(call: AgentCallRow): string {
  const outcome = classifyCallOutcome(call.outcome);
  if (call.call_score === null || call.call_score === undefined) {
    if (outcome === "void") return "no score — the market settled with no winner.";
    if (outcome === null) {
      return isPendingCallStatus(call.status)
        ? "no score yet — the market has not settled."
        : "no score — this call never reached a verdict.";
    }
    return "no score — murmur could not score this call.";
  }
  const score = formatScore(call.call_score);
  if (outcome === "win") {
    return `${score} — win. The call sat close to the outcome the venue published.`;
  }
  if (outcome === "loss") {
    return `${score} — loss. The call sat far from the outcome the venue published.`;
  }
  return `${score} — void. The market settled with no winner.`;
}
