import {
  marketFilterOptions,
  toggleTierValue,
  type FilterableMarket,
  type MarketFilterState,
  type TierOption,
} from "../../lib/market-filters.js";
import { MarketAssetIcon } from "./MarketAssetIcon.js";

/**
 * The checkable filter tiers above the markets matrix (owner sign-off
 * 2026-08-11): venue → category → series → market. Checked means on the
 * board. Every tier multi-selects in the same subtractive model the old
 * asset chips used, upper tiers narrow lower ones, and only what murmur
 * currently carries is ever offered — no option leads to an empty board.
 *
 * A tier holding exactly one value renders as a plain label, so today's
 * one-venue one-category board spends two quiet lines, not four control
 * rows. Series folds onto the category line until it branches.
 */
export function MarketFilterBar({
  rows,
  state,
  iconByMarketKey,
  onChange,
}: {
  rows: readonly FilterableMarket[];
  state: MarketFilterState;
  /** Market-tier chip artwork, keyed by leaf key; absent = no glyph. */
  iconByMarketKey: ReadonlyMap<string, string | null>;
  onChange: (next: MarketFilterState) => void;
}) {
  const options = marketFilterOptions(rows, state);
  const toggle = (
    tier: "venues" | "categories" | "series" | "markets",
    tierOptions: TierOption[],
    key: string,
  ) =>
    onChange({
      ...state,
      [tier]: toggleTierValue(
        state[tier],
        key,
        tierOptions.map((o) => o.key),
      ),
    });

  // The series tier only earns a row when it groups: Gamma names one series
  // per asset ("BTC Up or Down 5m"), and a tier whose every value holds
  // exactly one market is the market tier wearing longer names. It appears
  // once some series actually holds two or more leaves.
  const seriesGroups = options.series.length > 1 && seriesGroupsMarkets(rows);

  return (
    <div role="group" aria-label="Market filters">
      <Tier
        name="venue"
        options={options.venues}
        selected={state.venues}
        onToggle={(key) => toggle("venues", options.venues, key)}
        labelClass="ck-pos"
        singleSuffix={
          options.venues.length === 1
            ? `${options.venues[0]!.count} live`
            : null
        }
      />
      <Tier
        name="category"
        options={options.categories}
        selected={state.categories}
        onToggle={(key) => toggle("categories", options.categories, key)}
        lowercase
        singleSuffix={
          // One category and exactly one series: fold the series onto this
          // line rather than spending a row on a non-choice.
          options.categories.length === 1 && options.series.length === 1
            ? `· ${options.series[0]!.label}`
            : null
        }
      />
      {seriesGroups && (
        <Tier
          name="series"
          options={options.series}
          selected={state.series}
          onToggle={(key) => toggle("series", options.series, key)}
        />
      )}
      {options.markets.length > 1 && (
        <Tier
          name="market"
          options={options.markets}
          selected={state.markets}
          onToggle={(key) => toggle("markets", options.markets, key)}
          icons={iconByMarketKey}
        />
      )}
    </div>
  );
}

/** True when some series actually holds more than one market leaf. */
function seriesGroupsMarkets(rows: readonly FilterableMarket[]): boolean {
  const leavesBySeries = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = row.series ?? row.marketKey;
    const leaves = leavesBySeries.get(key) ?? new Set<string>();
    leaves.add(row.marketKey);
    leavesBySeries.set(key, leaves);
  }
  for (const leaves of leavesBySeries.values()) if (leaves.size > 1) return true;
  return false;
}

function Tier({
  name,
  options,
  selected,
  onToggle,
  icons,
  labelClass,
  lowercase,
  singleSuffix,
}: {
  name: string;
  options: TierOption[];
  selected: ReadonlySet<string> | null;
  onToggle: (key: string) => void;
  icons?: ReadonlyMap<string, string | null>;
  labelClass?: string;
  /** Display concern only: canonical labels stay Title Case in data, the
   *  cockpit reads lowercase. */
  lowercase?: boolean;
  singleSuffix?: string | null;
}) {
  if (options.length === 0) return null;
  const checkedCount =
    selected === null
      ? options.length
      : options.filter((o) => selected.has(o.key)).length;

  return (
    <div className="mmr-tier" role="group" aria-label={`Filter by ${name}`}>
      <span className="ck-label mmr-tier-name">{name}</span>
      {options.length === 1 ? (
        <>
          <span
            className={
              "ck-mono font-bold " +
              (lowercase ? "lowercase " : "") +
              (labelClass ?? "")
            }
          >
            {options[0]!.label}
          </span>
          {singleSuffix && (
            <span className="ck-mono ck-dim lowercase">{singleSuffix}</span>
          )}
        </>
      ) : (
        <>
          {options.map((option) => {
            const pressed = selected === null || selected.has(option.key);
            const iconUrl = icons?.get(option.key);
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={pressed}
                onClick={() => onToggle(option.key)}
                className={
                  "mmr-tier-chip ck-mono" + (pressed ? " is-on" : "")
                }
              >
                {iconUrl !== undefined && (
                  <MarketAssetIcon iconUrl={iconUrl} symbol={option.label} />
                )}
                <span
                  className={
                    "max-w-[260px] truncate" + (lowercase ? " lowercase" : "")
                  }
                >
                  {option.label}
                </span>
                <span className="ck-colhead">{option.count}</span>
              </button>
            );
          })}
          {/* A narrowed tier says so, so a filtered board never reads as a
              quiet market. At rest the count is the chips themselves. */}
          {checkedCount < options.length && (
            <span className="ml-auto ck-mono ck-dim whitespace-nowrap">
              {checkedCount} of {options.length}
            </span>
          )}
        </>
      )}
    </div>
  );
}
