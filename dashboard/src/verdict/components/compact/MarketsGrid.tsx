import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMarkets,
  fetchMarketsGrid,
  type MarketRow,
  type AgentMarketRow,
} from "../../api.js";
import { useStream } from "../../hooks/useStream.js";
import { mergeMarketAgentRow } from "../../hooks/stream-merge.js";
import { parseMarketConfig, marketDisplayName, type MarketConfig } from "../../lib/market-meta.js";
import { formatScore } from "../../lib/score-format.js";
import { useDetailDrawer, isPlainLeftClick } from "./DetailDrawer.js";

/**
 * Markets matrix — single dense table. One row per market, with the
 * top-3 agent slugs collapsed into a single mono cell so the operator
 * can scan the entire surface at a glance.
 */
export function CompactMarketsGrid({ limit }: { limit?: number }) {
  const [markets, setMarkets] = useState<MarketRow[] | null>(null);
  const [leaderboards, setLeaderboards] = useState<Record<string, AgentMarketRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<MarketFilters>(DEFAULT_FILTERS);
  const { markets: liveMarkets } = useStream();
  const { open } = useDetailDrawer();
  const searchRef = useRef<HTMLInputElement | null>(null);

  // "/" focuses the market search (terminal idiom). Ignored while another
  // field owns the keystroke, so typing elsewhere is never hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancel = false;
    setError(null);

    const fetchOnce = async (): Promise<MarketRow[]> => {
      try {
        return await fetchMarkets({ status: "listed" });
      } catch (firstErr) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (cancel) throw firstErr;
        return await fetchMarkets({ status: "listed" });
      }
    };

    fetchOnce()
      .then(async (rows) => {
        if (cancel) return;
        setMarkets(rows);
        // ONE batched request for every market's top-3 (replaces the former
        // per-market leaderboard fan-out). Markets with no scoring calls are
        // omitted from the response; the render defaults them to an empty
        // top-3 via `merged[m.market_id] ?? []`, so behavior is unchanged.
        // A batch failure leaves leaderboards empty (grid still renders the
        // market rows) rather than erroring the whole surface.
        try {
          const entries = await fetchMarketsGrid({ limit: 3 });
          if (cancel) return;
          setLeaderboards(
            Object.fromEntries(entries.map((e) => [e.market_id, e.agents])),
          );
        } catch {
          if (!cancel) setLeaderboards({});
        }
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, []);

  const merged = useMemo<Record<string, AgentMarketRow[]>>(() => {
    const out: Record<string, AgentMarketRow[]> = { ...leaderboards };
    for (const [market_id, evt] of Object.entries(liveMarkets)) {
      // markets.update rows are the lean wire shape; fold them onto the prior
      // REST rows for this market keyed by agent_id, PRESERVING the REST-only
      // fields (matching LeaderboardPage / MarketDetailPage). This grid renders
      // only display_slug + verdict_score, so preserving is invisible here, but
      // it keeps the single merge policy consistent across all three consumers.
      const byAgent = new Map(
        (leaderboards[market_id] ?? []).map((r) => [r.agent_id, r]),
      );
      out[market_id] = evt.agents
        .slice(0, 3)
        .map((a) => mergeMarketAgentRow(a, byAgent.get(a.agent_id)));
    }
    return out;
  }, [leaderboards, liveMarkets]);

  if (error) {
    return <div className="px-2 py-2 ck-mono ck-neg">[error] {error}</div>;
  }
  if (!markets) {
    return <MarketsSkeleton />;
  }
  if (markets.length === 0) {
    return <div className="px-2 py-2 ck-mono ck-dim">[no markets listed]</div>;
  }

  const filtered = markets.filter((m) => {
    const cfg = parseMarketConfig(m);
    if (filters.venue !== "all" && marketVenue(m) !== filters.venue) return false;
    if (filters.klass !== "all" && marketClass(m) !== filters.klass) return false;
    if (filters.hzn !== "all" && horizonBucket(m, cfg) !== filters.hzn) return false;
    if (filters.state !== "all") {
      const calls = (merged[m.market_id] ?? []).length;
      if (filters.state === "open" && calls > 0) return false;
      if (filters.state === "active" && calls === 0) return false;
    }
    if (filters.q) {
      const hay = [
        m.market_id,
        m.asset_id,
        cfg?.question ?? "",
        cfg?.slug ?? "",
        marketDisplayName(m),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(filters.q.toLowerCase())) return false;
    }
    return true;
  });
  const visible = limit ? filtered.slice(0, limit) : filtered;

  return (
    <div>
      <MarketFilterBar
        filters={filters}
        setFilters={setFilters}
        searchRef={searchRef}
        shown={visible.length}
        total={markets.length}
      />
      {visible.length === 0 && (
        <div className="px-2 py-2 flex flex-wrap items-center gap-2 ck-mono ck-dim">
          <span>
            {filters.q
              ? `[no markets match "${filters.q}"]`
              : "[no markets match these filters]"}
          </span>
          <button
            type="button"
            onClick={() =>
              setFilters(filters.q ? { ...filters, q: "" } : DEFAULT_FILTERS)
            }
            className="ck-btn ck-btn-bracket"
          >
            clear
          </button>
        </div>
      )}
    <ul className="m-0 p-0 list-none">
      <li className={`grid ${GRID_COLS} gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead`}>
        <span aria-hidden="true" />
        <span>market</span>
        <span>class</span>
        <span>horizon</span>
        <span className="text-right">n</span>
        <span>top-3</span>
        <span className="text-right">lead</span>
      </li>
      {visible.map((m) => {
        const top = merged[m.market_id] ?? [];
        const leader = top[0];
        const cfg = parseMarketConfig(m);
        const displayName = marketDisplayName(m);
        return (
          <li
            key={m.market_id}
            className={`relative grid ${GRID_COLS} gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)] ck-hoverable`}
          >
            {/* Stretched row link — real box so keyboard focus lands. */}
            <a
              href={`#/markets/${encodeURIComponent(m.market_id)}`}
              aria-label={`open market ${displayName}`}
              onClick={(e) => {
                if (isPlainLeftClick(e)) {
                  e.preventDefault();
                  open("market", m.market_id);
                }
              }}
              className="ck-rowlink"
            />
            <span className="contents">
              <AssetGlyph market={m} />
              <span
                className="ck-mono ck-pos truncate"
                title={displayName === m.market_id ? m.market_id : `${displayName} · ${m.market_id}`}
              >
                {displayName}
              </span>
              <span
                className="ck-mono ck-dim truncate"
                title={m.market_taxonomy?.label ?? m.market_kind}
              >
                {shortTaxonomyLabel(m)}
              </span>
              <span className="ck-mono ck-dim whitespace-nowrap" title={cfg?.endDate ? `closes ${cfg.endDate}` : undefined}>
                {formatCloses(cfg?.endDate) ?? formatHorizon(m.horizon_seconds)}
              </span>
              <span className="ck-mono ck-dim text-right">
                {top.length > 0 ? String(top.length).padStart(2, "0") : "—"}
              </span>
              <span className={"ck-mono truncate " + (top.length === 0 ? "ck-dim" : "ck-dim")}>
                {top.length === 0
                  ? "open · awaiting first call"
                  : top.map((a) => a.display_slug).join(" · ")}
              </span>
              <span
                className={
                  "ck-mono text-right " +
                  (leader
                    ? (leader.verdict_score ?? 0) >= 0
                      ? "ck-pos"
                      : "ck-neg"
                    : "ck-dim")
                }
              >
                {formatScore(leader?.verdict_score ?? null)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
    </div>
  );
}

// ─── Filters ────────────────────────────────────────────────────────────────

type MarketVenue = "all" | "native" | "polymarket";
type MarketClassFilter = "all" | "price" | "event";
type HznBucket = "all" | "1h" | "1d" | "1w" | "1w+";
type MarketState = "all" | "open" | "active";

interface MarketFilters {
  q: string;
  venue: MarketVenue;
  klass: MarketClassFilter;
  hzn: HznBucket;
  state: MarketState;
}

const DEFAULT_FILTERS: MarketFilters = {
  q: "",
  venue: "all",
  klass: "all",
  hzn: "all",
  state: "all",
};

function marketVenue(m: MarketRow): Exclude<MarketVenue, "all"> {
  return m.adapter_id === "polymarket-gamma" ? "polymarket" : "native";
}

function marketClass(m: MarketRow): Exclude<MarketClassFilter, "all"> {
  const klass = m.market_taxonomy?.resolution_class ?? m.market_kind;
  return String(klass).startsWith("price") ? "price" : "event";
}

/** Bucket by effective remaining time: live endDate when present, else horizon. */
function horizonBucket(m: MarketRow, cfg: MarketConfig | null): Exclude<HznBucket, "all"> {
  let sec = m.horizon_seconds;
  if (cfg?.endDate) {
    const remaining = (Date.parse(cfg.endDate) - Date.now()) / 1000;
    if (Number.isFinite(remaining)) sec = Math.max(0, remaining);
  }
  if (sec <= 3600) return "1h";
  if (sec <= 86400) return "1d";
  if (sec <= 604800) return "1w";
  return "1w+";
}

function MarketFilterBar({
  filters,
  setFilters,
  searchRef,
  shown,
  total,
}: {
  filters: MarketFilters;
  setFilters: (f: MarketFilters) => void;
  /** Focus target for the global "/" shortcut owned by the grid. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  shown: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b border-[var(--color-border)]">
      <input
        ref={searchRef}
        type="search"
        value={filters.q}
        onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        placeholder="search [/]"
        aria-label="Search markets"
        className="ck-mono bg-transparent border border-[var(--color-border)] px-1.5 py-[1px] w-[110px] outline-none focus:border-[var(--color-border-vis)] placeholder:text-[var(--color-dim)]"
      />
      <FilterGroup
        label="venue"
        value={filters.venue}
        options={["all", "native", "polymarket"] as const}
        onPick={(venue) => setFilters({ ...filters, venue })}
      />
      <FilterGroup
        label="class"
        value={filters.klass}
        options={["all", "price", "event"] as const}
        onPick={(klass) => setFilters({ ...filters, klass })}
      />
      <FilterGroup
        label="hzn"
        value={filters.hzn}
        options={["all", "1h", "1d", "1w", "1w+"] as const}
        onPick={(hzn) => setFilters({ ...filters, hzn })}
      />
      <FilterGroup
        label="state"
        value={filters.state}
        options={["all", "open", "active"] as const}
        onPick={(state) => setFilters({ ...filters, state })}
      />
      <span className="ml-auto ck-mono ck-dim tabular-nums">
        {shown}/{total}
      </span>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onPick: (v: T) => void;
}) {
  return (
    <span className="flex items-center gap-1 ck-mono">
      <span className="ck-label">{label}</span>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onPick(opt)}
          className={
            "ck-mono px-1 py-0 bg-transparent border-0 cursor-pointer " +
            (opt === value ? "ck-pos underline underline-offset-2" : "ck-dim hover:text-[var(--color-text)]")
          }
        >
          {opt}
        </button>
      ))}
    </span>
  );
}

// Name and top-3 share the flexible width (the two variable-length cells);
// fixed columns are sized to their widest real content so nothing truncates
// or wraps ("polymarket" 110px, "7d left" 76px) and row height stays constant.
const GRID_COLS =
  "grid-cols-[18px_minmax(220px,1.1fr)_110px_76px_44px_minmax(180px,1.3fr)_64px]";

/** Compact time-to-close from an ISO endDate (external event markets). */
function formatCloses(endDate: string | undefined): string | null {
  if (!endDate) return null;
  const ms = Date.parse(endDate) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "closed";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m left`;
  if (hours < 48) return `${Math.round(hours)}h left`;
  return `${Math.round(hours / 24)}d left`;
}

/** Leading glyph: token mark for native price markets, venue mark for venues. */
function AssetGlyph({ market }: { market: MarketRow }) {
  const sym = shortAssetSlug(market.asset_id);
  if (market.adapter_id === "polymarket-gamma" || market.asset_id === "polymarket:event") {
    return (
      <img
        src="/brand/tokens/polymarket.png"
        alt=""
        aria-hidden="true"
        className="w-[11px] h-[13px] opacity-70 justify-self-center"
      />
    );
  }
  if (sym === "eth") {
    return (
      <svg
        viewBox="0 0 12 19"
        aria-hidden="true"
        className="w-[10px] h-[15px] opacity-70 justify-self-center"
        fill="currentColor"
      >
        <path d="M6 0L0 9.6l6 3.4 6-3.4L6 0z" opacity="0.9" />
        <path d="M0 10.8L6 19l6-8.2-6 3.4-6-3.4z" opacity="0.55" />
      </svg>
    );
  }
  return <span aria-hidden="true" className="ck-dim text-center leading-none">·</span>;
}

function MarketsSkeleton() {
  // Hairline skeleton matching the row grid. No spinner per DESIGN.md §10.
  return (
    <ul className="m-0 p-0 list-none">
      <li className={`grid ${GRID_COLS} gap-1.5 items-center px-2 py-1 border-b border-[var(--color-border-vis)] ck-colhead`}>
        <span aria-hidden="true" />
        <span>market</span>
        <span>class</span>
        <span>horizon</span>
        <span className="text-right">n</span>
        <span>top-3</span>
        <span className="text-right">lead</span>
      </li>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li
          key={i}
          className={`grid ${GRID_COLS} gap-1.5 items-center px-2 py-[3px] border-b border-[var(--color-border)]`}
        >
          <div className="h-[10px] bg-[var(--color-border)] w-[10px]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[80%]" />
          <div className="h-[10px] bg-[var(--color-border)] w-[60%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[28px]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[18px] justify-self-end" />
          <div className="h-[10px] bg-[var(--color-border)] w-[70%]" />
          <div className="h-[8px] bg-[var(--color-border)] w-[40px] justify-self-end" />
        </li>
      ))}
    </ul>
  );
}

function formatHorizon(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 60 * 60 * 24) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 60 * 60 * 24 * 7) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / (86400 * 7))}w`;
}

function shortAssetSlug(asset_id: string): string {
  const parts = asset_id.split(":");
  const sym = parts.length >= 2 ? parts[1] : asset_id;
  return (sym ?? asset_id).toLowerCase();
}

function shortTaxonomyLabel(market: MarketRow): string {
  // Venue-adapter rows read better as the venue name than as a truncated
  // resolution class ("even-bina").
  if (market.adapter_id === "polymarket-gamma") return "polymarket";
  const klass = market.market_taxonomy?.resolution_class ?? market.market_kind;
  if (klass === "price_direction") return shortAssetSlug(market.asset_id).toUpperCase();
  return klass
    .split("_")
    .map((part) => part.slice(0, 4))
    .join("-");
}
