import { memo, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Pulse,
  ShieldCheck,
  Sparkle,
  Stack,
  Waveform,
} from "@phosphor-icons/react/dist/ssr";

// Structural type so we don't depend on Phosphor's internal Icon type, which
// isn't re-exported by /dist/ssr.
type Icon = React.ComponentType<{
  size?: number | string;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
  className?: string;
}>;
import { verdictApi, type TodayFeed, type TodayFeedRow } from "../api.js";
import { Header } from "../components/Header.js";
import { pill, surface, text, outcomeTone } from "../ui/tokens.js";

// ─── Animation primitives ────────────────────────────────────────────────────

const SPRING = { type: "spring" as const, stiffness: 110, damping: 22 };

const STAGGER_PARENT: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.05 },
  },
};

const STAGGER_CHILD: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: SPRING },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export function TodayPage() {
  const [feed, setFeed] = useState<TodayFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      verdictApi
        .todayFeed()
        .then((f) => { if (!cancelled) setFeed(f); })
        .catch((e) => { if (!cancelled) setError(e.message); });
    };
    load();
    const id = setInterval(load, 15_000);
    const tick = setInterval(() => setNow(new Date()), 1_000);
    return () => { cancelled = true; clearInterval(id); clearInterval(tick); };
  }, []);

  return (
    <div className={surface.page + " min-h-[100dvh]"}>
      <div className="mx-auto max-w-[1400px] px-6 md:px-10">
        <Header />

        {/* ── Stat bar (Bento row 1) ── */}
        <motion.section
          className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4"
          variants={STAGGER_PARENT}
          initial="hidden"
          animate="visible"
        >
          <Stat
            label="Accepted (24h)"
            icon={Stack}
            value={feed?.totals.accepted_24h ?? null}
            tone="neutral"
          />
          <Stat
            label="Resolved (24h)"
            icon={ShieldCheck}
            value={feed?.totals.resolved_24h ?? null}
            tone="neutral"
          />
          <Stat
            label="Wins (24h)"
            icon={ArrowUp}
            value={feed?.totals.wins_24h ?? null}
            tone="good"
          />
          <Stat
            label="Losses (24h)"
            icon={ArrowDown}
            value={feed?.totals.losses_24h ?? null}
            tone="bad"
          />
        </motion.section>

        {error && (
          <div
            className={
              surface.card +
              " mt-6 px-5 py-3 font-mono text-sm text-[var(--color-warn)]"
            }
            role="alert"
          >
            could not load feed: {error}
          </div>
        )}

        {/* ── Bento body (Pending / Resolved / New) ── */}
        <motion.section
          className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4"
          variants={STAGGER_PARENT}
          initial="hidden"
          animate="visible"
        >
          <Column
            title="Pending resolution"
            subtitle="Calls being judged right now"
            icon={Clock}
            tone="accent"
            isEmpty={!feed?.pending_resolution?.length}
            emptyText="No pending calls. Quiet today."
          >
            <AnimatePresence initial={false}>
              {(feed?.pending_resolution ?? []).slice(0, 10).map((row) => (
                <PendingRow key={row.call_id} row={row} now={now} />
              ))}
            </AnimatePresence>
          </Column>

          <Column
            title="Just resolved"
            subtitle="Most recent outcomes"
            icon={ShieldCheck}
            tone="good"
            isEmpty={!feed?.resolved_recent?.length}
            emptyText="Nothing resolved yet."
          >
            <AnimatePresence initial={false}>
              {(feed?.resolved_recent ?? []).slice(0, 10).map((row) => (
                <ResolvedRow key={row.call_id} row={row} />
              ))}
            </AnimatePresence>
          </Column>

          <Column
            title="New calls"
            subtitle="Latest entries to the tape"
            icon={Sparkle}
            tone="neutral"
            isEmpty={!feed?.accepted_recent?.length}
            emptyText="No calls yet today."
          >
            <AnimatePresence initial={false}>
              {(feed?.accepted_recent ?? []).slice(0, 10).map((row) => (
                <AcceptedRow key={row.call_id} row={row} />
              ))}
            </AnimatePresence>
          </Column>
        </motion.section>

        {/* ── Movers carousel — perpetual motion, isolated client-component ── */}
        {feed?.movers && feed.movers.length > 0 && (
          <MoversBand movers={feed.movers} />
        )}

        {/* ── Footer / live status ── */}
        <div className="mt-10 flex items-center justify-between gap-3 pb-12">
          <div className="flex items-center gap-2 text-xs font-mono text-[var(--color-text-faint)]">
            <span
              aria-hidden
              className="live-dot inline-block size-1.5 rounded-full bg-[var(--color-accent)]"
            />
            <span>
              {feed
                ? `served ${ago(now, feed.served_at)} · refresh in ${
                    15 -
                    Math.min(
                      14,
                      Math.floor(
                        (now.getTime() - Date.parse(feed.served_at)) / 1000,
                      ),
                    )
                  }s`
                : "loading feed…"}
            </span>
          </div>
          <a
            href="#/leaderboard"
            className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            full leaderboard →
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

const Stat = memo(function Stat({
  label,
  value,
  tone,
  icon: IconCmp,
}: {
  label: string;
  value: number | null;
  tone: "good" | "bad" | "neutral";
  icon: Icon;
}) {
  const toneColor =
    tone === "good"
      ? "text-[var(--color-win)]"
      : tone === "bad"
      ? "text-[var(--color-loss)]"
      : "text-[var(--color-text)]";

  return (
    <motion.div
      variants={STAGGER_CHILD}
      className={
        surface.card +
        " px-5 py-4 flex flex-col gap-2.5 transition " +
        "hover:border-[var(--color-border)]"
      }
    >
      <div className="flex items-center justify-between">
        <span className={text.cardTitle}>{label}</span>
        <IconCmp size={14} weight="bold" className="text-[var(--color-text-faint)]" />
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`${text.num} text-3xl font-medium tracking-tight ${toneColor}`}>
          {value === null ? <span className="skeleton inline-block h-7 w-12 rounded" /> : value}
        </span>
      </div>
    </motion.div>
  );
});

// ─── Column ───────────────────────────────────────────────────────────────────

function Column({
  title,
  subtitle,
  icon: IconCmp,
  tone,
  isEmpty,
  emptyText,
  children,
}: {
  title: string;
  subtitle: string;
  icon: Icon;
  tone: "good" | "bad" | "neutral" | "accent";
  isEmpty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  const toneAccent =
    tone === "good"
      ? "text-[var(--color-win)]"
      : tone === "bad"
      ? "text-[var(--color-loss)]"
      : tone === "accent"
      ? "text-[var(--color-accent)]"
      : "text-[var(--color-text-muted)]";

  return (
    <motion.div
      variants={STAGGER_CHILD}
      className={surface.card + " p-5 flex flex-col gap-3 min-h-[300px]"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="flex items-center gap-2 text-[15px] font-medium tracking-tight">
            <IconCmp size={16} weight="bold" className={toneAccent} />
            {title}
          </span>
          <span className={text.cardTitle + " mt-0.5"}>{subtitle}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2 flex-1 min-h-0">
        {isEmpty ? <Empty text={emptyText} /> : children}
      </div>
    </motion.div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center flex-1 px-3 py-6 text-center">
      <span className="text-xs font-mono text-[var(--color-text-faint)] leading-relaxed">
        {text}
      </span>
    </div>
  );
}

// ─── Row variants ─────────────────────────────────────────────────────────────

function rowBase() {
  return (
    "group relative block px-3.5 py-2.5 rounded-2xl bg-[var(--color-surface-2)] " +
    "border border-transparent hover:border-[var(--color-border)] " +
    "transition no-underline"
  );
}

function sideClass(side: "BUY" | "SELL") {
  return side === "BUY" ? "text-[var(--color-win)]" : "text-[var(--color-loss)]";
}

function PendingRow({ row, now }: { row: TodayFeedRow; now: Date }) {
  const eta = row.t1_estimate ? Date.parse(row.t1_estimate) - now.getTime() : 0;
  const overdue = eta < 0;
  return (
    <motion.a
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={SPRING}
      href={`#/calls/${row.call_id}`}
      className={rowBase()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium truncate">{row.agent_slug}</span>
          <span className={`${text.num} text-[11px] ${sideClass(row.side)}`}>
            {row.side}
          </span>
          <span className={`${text.num} text-[11px] text-[var(--color-text-muted)]`}>
            {assetTicker(row.asset_id)} {row.horizon_hours}h
          </span>
        </div>
        <span className={`${text.num} text-[11px] text-[var(--color-text-muted)]`}>
          @{(row.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono">
        {overdue ? (
          <>
            <Waveform size={11} weight="bold" className="text-[var(--color-warn)]" />
            <span className="text-[var(--color-warn)]">resolving…</span>
          </>
        ) : (
          <>
            <Clock size={11} weight="bold" className="text-[var(--color-text-faint)]" />
            <span className="text-[var(--color-text-faint)]">
              resolves in {formatDuration(eta)}
            </span>
          </>
        )}
      </div>
    </motion.a>
  );
}

function ResolvedRow({ row }: { row: TodayFeedRow }) {
  const tone = outcomeTone(row.outcome);
  const ret =
    row.signed_return !== null && row.signed_return !== undefined
      ? `${(Number(row.signed_return) * 100).toFixed(2)}%`
      : "—";
  return (
    <motion.a
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={SPRING}
      href={`#/calls/${row.call_id}`}
      className={rowBase()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium truncate">{row.agent_slug}</span>
          <span className={`${text.num} text-[11px] ${sideClass(row.side)}`}>
            {row.side}
          </span>
          <span className={`${text.num} text-[11px] text-[var(--color-text-muted)]`}>
            {assetTicker(row.asset_id)} {row.horizon_hours}h
          </span>
        </div>
        <span className={pill[tone]}>{row.outcome ?? "—"}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[11px] font-mono">
        <span className="text-[var(--color-text-faint)]">return</span>
        <span className={`${text.num} ${row.outcome === "win" ? "text-[var(--color-win)]" : row.outcome === "loss" ? "text-[var(--color-loss)]" : "text-[var(--color-text-muted)]"}`}>
          {ret}
        </span>
      </div>
    </motion.a>
  );
}

function AcceptedRow({ row }: { row: TodayFeedRow }) {
  return (
    <motion.a
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={SPRING}
      href={`#/calls/${row.call_id}`}
      className={rowBase()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium truncate">{row.agent_slug}</span>
          <span className={`${text.num} text-[11px] ${sideClass(row.side)}`}>
            {row.side}
          </span>
          <span className={`${text.num} text-[11px] text-[var(--color-text-muted)]`}>
            {assetTicker(row.asset_id)} {row.horizon_hours}h
          </span>
        </div>
        <span className={`${text.num} text-[11px] text-[var(--color-text-muted)]`}>
          @{(row.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <div className={`${text.num} mt-1.5 text-[11px] text-[var(--color-text-faint)]`}>
        {row.accepted_at.replace("T", " ").replace("Z", "")}
      </div>
    </motion.a>
  );
}

// ─── Movers carousel — isolated, memoized, perpetual motion ──────────────────

const MoversBand = memo(function MoversBand({
  movers,
}: {
  movers: NonNullable<TodayFeed["movers"]>;
}) {
  // Duplicate the list so the marquee loops seamlessly without snap.
  const items = useMemo(() => [...movers, ...movers], [movers]);

  return (
    <section className="mt-6 overflow-hidden">
      <div className="mb-3 flex items-center gap-2">
        <Pulse size={14} weight="bold" className="text-[var(--color-accent)]" />
        <span className={text.cardTitle}>Movers · 24h</span>
      </div>
      <div className="relative">
        {/* edge fades */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-[var(--color-bg)] to-transparent z-10"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[var(--color-bg)] to-transparent z-10"
        />
        <motion.div
          className="flex gap-3 will-change-transform"
          animate={{ x: ["0%", "-50%"] }}
          transition={{ duration: 32, ease: "linear", repeat: Infinity }}
        >
          {items.map((m, i) => {
            const winRate =
              m.delta_24h_calls > 0
                ? m.delta_24h_wins / m.delta_24h_calls
                : null;
            return (
              <a
                key={`${m.agent_id}-${i}`}
                href={`#/agents/${m.agent_slug}`}
                className={
                  surface.cardFeatured +
                  " shrink-0 px-4 py-3 flex items-center gap-3 min-w-[260px] " +
                  "border-[var(--color-border-soft)] hover:border-[var(--color-border)] " +
                  "transition no-underline"
                }
              >
                <div className="size-7 rounded-full bg-[var(--color-bg)] border border-[var(--color-border-soft)] flex items-center justify-center">
                  <span className={`${text.num} text-[11px] text-[var(--color-text-muted)]`}>
                    {m.display_name.slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-[13px] font-medium truncate text-[var(--color-text)]">
                    {m.display_name}
                  </span>
                  <span className={`${text.num} text-[11px] text-[var(--color-text-faint)]`}>
                    {m.delta_24h_calls} calls ·{" "}
                    {winRate === null ? "—" : `${(winRate * 100).toFixed(0)}% win`}
                  </span>
                </div>
              </a>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${(abs / 3_600_000).toFixed(1)}h`;
  return `${(abs / 86_400_000).toFixed(1)}d`;
}

function ago(now: Date, iso: string): string {
  const diff = now.getTime() - Date.parse(iso);
  if (diff < 30_000) return "just now";
  return formatDuration(diff) + " ago";
}

function assetTicker(assetId: string): string {
  // base:ETH:USD → ETH
  return assetId.split(":")[1] ?? assetId;
}

