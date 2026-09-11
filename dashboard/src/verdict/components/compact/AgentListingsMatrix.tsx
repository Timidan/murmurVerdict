// ─── The browse matrix: who lists BTC-5m, at what price, with what record ───
//
// Rows are agents, columns are venue series, and a cell is that agent's
// STANDING listing — `current_terms`, i.e. what their NEXT sealed call in that
// series would cost. A cell never carries a buy affordance, because nothing is
// on offer at that number yet: an already-sealed call is sold at the
// `locked_terms` frozen onto it, which can legitimately differ, and it appears
// only inside the per-cell drilldown. See lib/listings-matrix.ts.
//
// The catalog and the per-call inventory are fetched in PARALLEL as two
// independent chains, so a failing inventory read annotates the matrix instead
// of blanking it — the standing prices are true either way.
//
// The BUY lives in the drilldown, on the locked price itself. See
// OpenCallsDrilldown below for why it belongs there and nowhere else on the
// page, and components/compact/BuyAccessPanel.tsx for the checkout.

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import { verdictApi, type MarketplaceListings } from "../../api.js";
import { Ik } from "../../icons.js";
import {
  availabilityLine,
  buildListingsMatrix,
  CELL_PRICE_TOOLTIP,
  matrixEmptyState,
  matrixGridTemplate,
  UNLISTED,
  type AvailabilityFeed,
  type MatrixCell,
  type MatrixColumn,
  type MatrixRow,
  type OpenCallView,
} from "../../lib/listings-matrix.js";
import { formatLocalDateTime, formatLocalTimeLabel } from "../../lib/date-time-format.js";
import { shortId } from "../../lib/display-format.js";
import { InlineError } from "./InlineError.js";
import { Panel } from "./Panel.js";
import { SkeletonBar } from "./PanelSkeleton.js";
import { useNowMs } from "./TimeAgo.js";

/**
 * The checkout, loaded only when somebody opens a call to buy.
 *
 * `lazy()` and not a plain import, because this component pulls the Privy SDK
 * in with it. /leaderboard is a public route that Router.tsx deliberately keeps
 * outside the Privy bundle; deferring the chunk to the click keeps that true
 * while still putting the buy where a buyer is standing.
 */
const BuyAccessPanel = lazy(() =>
  import("./BuyAccessPanel.js").then((m) => ({ default: m.BuyAccessPanel })),
);

/** One page of inventory is plenty: the storefront is per-deployment, not global. */
const SELLABLE_PAGE = 200;

/** Which cell's calls are expanded. Component state — no URL overlay. */
interface Drilldown {
  agentId: string;
  venueSeriesId: string;
}

export function AgentListingsMatrix() {
  const [catalog, setCatalog] = useState<MarketplaceListings | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [feed, setFeed] = useState<AvailabilityFeed>({ status: "loading" });
  const [drill, setDrill] = useState<Drilldown | null>(null);

  // TWO chains, not one Promise.all: `all` rejects on the first failure, which
  // would let a 503 on the inventory route blank a catalog that loaded fine.
  useEffect(() => {
    let cancelled = false;
    verdictApi
      .marketplaceListings()
      .then((r) => {
        if (!cancelled) setCatalog(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setCatalogError(e.message);
      });
    verdictApi
      .sellableCalls({ limit: SELLABLE_PAGE })
      .then((r) => {
        if (!cancelled) {
          setFeed({
            status: "ok",
            purchaseAvailable: r.purchase_available,
            calls: r.calls,
          });
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setFeed({ status: "error", message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The shared 30s ticker, so a sale window that runs out stops offering a buy
  // without a reload and without a second timer on the page.
  const nowMs = useNowMs();
  const matrix = useMemo(
    () => buildListingsMatrix(catalog, feed, nowMs),
    [catalog, feed, nowMs],
  );
  const empty = matrixEmptyState(matrix);
  const line = availabilityLine(feed, matrix);

  const toggle = useCallback((agentId: string, venueSeriesId: string) => {
    setDrill((prev) =>
      prev && prev.agentId === agentId && prev.venueSeriesId === venueSeriesId
        ? null
        : { agentId, venueSeriesId },
    );
  }, []);

  const opened = useMemo(() => {
    if (!drill) return null;
    const row = matrix.rows.find((r) => r.agentId === drill.agentId);
    const column = matrix.columns.find((c) => c.venueSeriesId === drill.venueSeriesId);
    const cell = row?.cells.find((c) => c.venueSeriesId === drill.venueSeriesId);
    if (!row || !column || !cell || cell.openCalls.length === 0) return null;
    return { row, column, cell };
  }, [drill, matrix]);

  const template = matrixGridTemplate(matrix.columns.length);
  const gridStyle: CSSProperties = {
    gridTemplateColumns: template.gridTemplateColumns,
    minWidth: template.minWidth,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto ck-scroll">
      <Panel
        title={
          <>
            <Ik name="market" /> listings
          </>
        }
        /* The panel's own annotation says which of the two prices the cells
           carry, once, rather than repeating it in every column header. The
           counts describe THIS population — the page's ladder ribbon counts a
           different one (every ranked agent, seller or not), so it is hidden
           in this view rather than left to describe the wrong rows. */
        meta={
          catalog === null
            ? "next-call list price"
            : `${matrix.rows.length} seller${matrix.rows.length === 1 ? "" : "s"} · ${matrix.columns.length} series · next-call list price`
        }
      >
        {catalogError && <InlineError error={catalogError} className="px-2 py-2 ck-mono" />}
        {!catalogError && catalog === null && <MatrixSkeleton />}
        {!catalogError && catalog !== null && empty && (
          <p className="px-2 py-2 m-0 ck-mono ck-dim">[{empty}]</p>
        )}
        {!catalogError && catalog !== null && !empty && (
          <div className="ck-matrix" style={gridStyle} role="table" aria-label="agent listings by series">
            <div className="ck-matrix-row" role="row">
              <div className="ck-matrix-corner ck-colhead" role="columnheader">
                agent · all-time record
              </div>
              {matrix.columns.map((column) => (
                <ColumnHead key={column.venueSeriesId} column={column} />
              ))}
            </div>
            {matrix.rows.map((row) => (
              <div className="ck-matrix-row" role="row" key={row.agentId}>
                <RowHead row={row} />
                {row.cells.map((cell, i) => (
                  <Cell
                    key={cell.venueSeriesId}
                    cell={cell}
                    row={row}
                    column={matrix.columns[i]}
                    expanded={
                      drill?.agentId === row.agentId &&
                      drill?.venueSeriesId === cell.venueSeriesId
                    }
                    onToggle={toggle}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Availability sits OUTSIDE the scrolling grid so it never drifts
          sideways with it, and so it stays readable in every failure state. */}
      <p
        className={
          "px-2 py-1.5 m-0 ck-mono border-b border-[var(--color-border)] " +
          (line.tone === "error" ? "ck-neg" : "ck-dim")
        }
      >
        {line.text}
      </p>

      {opened && (
        <OpenCallsDrilldown
          slug={opened.row.slug}
          seriesTitle={opened.column.title}
          calls={opened.cell.openCalls}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

/**
 * Series titles are the STORED `series_title`. They truncate visually and carry
 * the full string in `title=` — nothing here parses an asset or a window out of
 * a slug, because the slug is an identifier, not a description.
 */
function ColumnHead({ column }: { column: MatrixColumn }) {
  return (
    <div className="ck-matrix-colhead" role="columnheader">
      <span className="ck-colhead ck-matrix-truncate" title={column.title}>
        {column.title}
      </span>
      <span
        className="ck-mono ck-dim ck-matrix-sub"
        title={`${column.venue}${column.category ? ` · ${column.category}` : ""} · ${column.venueSeriesId}`}
      >
        {column.sellers === 0 ? "no sellers" : `${column.sellers} listing${column.sellers === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}

/**
 * The sticky row header: handle plus the whole all-time record in ONE cell.
 *
 * Three more frozen columns would eat the comparison area the matrix exists
 * for, so floor / win / scored are packed here and labelled all-time — the
 * record is GLOBAL, never per series, and an unscored agent shows its nulls
 * rather than being dropped from the board.
 */
function RowHead({ row }: { row: MatrixRow }) {
  return (
    <div className="ck-matrix-head" role="rowheader">
      <a
        href={`#/agents/${row.slug}`}
        className="ck-mono ck-pos ck-matrix-truncate no-underline"
        title={row.displayName}
      >
        {row.slug}
      </a>
      <span className="ck-matrix-record ck-mono ck-dim" title={row.track.summary}>
        <span className="ck-label">all-time</span>
        <span>
          floor <span className={row.track.unscored ? "ck-dim" : "ck-pos"}>{row.track.floor}</span>
        </span>
        <span>
          win <span className={row.track.unscored ? "ck-dim" : "ck-pos"}>{row.track.winRate}</span>
        </span>
        <span>
          scored <span className={row.track.unscored ? "ck-dim" : "ck-pos"}>{row.track.resolved}</span>
        </span>
      </span>
    </div>
  );
}

/**
 * One (agent, series) cell.
 *
 * The number is `current_terms`. The `n open` marker beside it is NOT a buy
 * button and does not quote this number — it opens the drilldown, where each
 * call carries its own `locked_terms`.
 */
function Cell({
  cell,
  row,
  column,
  expanded,
  onToggle,
}: {
  cell: MatrixCell;
  row: MatrixRow;
  column: MatrixColumn;
  expanded: boolean;
  onToggle: (agentId: string, venueSeriesId: string) => void;
}) {
  const open = cell.openCalls.length;
  // Colour only for genuine state: the marker greens only when a seat can
  // actually be bought on this deployment right now.
  const buyable = cell.openCalls.filter((c) => c.buyable).length;
  return (
    <div className="ck-matrix-cell" role="cell">
      {cell.listPrice ? (
        <span className="ck-mono ck-pos" title={CELL_PRICE_TOOLTIP}>
          {cell.listPrice.display}{" "}
          <span className="ck-dim">{cell.listPrice.currency.toUpperCase()}</span>
        </span>
      ) : (
        <span
          className="ck-mono ck-dim"
          title={`${row.slug} does not list ${column.title}`}
        >
          {UNLISTED}
        </span>
      )}
      {open > 0 && (
        <button
          type="button"
          onClick={() => onToggle(row.agentId, cell.venueSeriesId)}
          aria-expanded={expanded}
          className={
            "ck-tag ck-matrix-open " +
            (buyable > 0 ? "ck-tag-ok " : "") +
            (expanded ? "ck-matrix-open-on" : "")
          }
          /* `n open` counts sealed calls, and a sealed call is not a seat on
             offer — a full cohort or a closed sale window leaves it listed and
             unbuyable. The tooltip says which of the two the reader is looking
             at rather than promising a buy for every row. */
          title={
            buyable === 0
              ? `${open} sealed call${open === 1 ? "" : "s"} from ${row.slug} on ${column.title}. None takes a new buyer right now.`
              : `${buyable} sealed call${buyable === 1 ? " is" : "s are"} open to buy from ${row.slug} on ${column.title}, each at the price locked when it was sealed.`
          }
        >
          {open} open
        </button>
      )}
    </div>
  );
}

/**
 * The open calls behind one cell. EVERY row here is `locked_terms` — the
 * standing price is deliberately absent, so nothing in this list can be read
 * as the number the cell above shows.
 *
 * This is also where the BUY lives, and that is why it lives here rather than
 * on the call page: this list is the only surface in the browser that already
 * renders the price a checkout will honour. The button and the number it
 * charges come from one object, so no lookup can substitute the standing price
 * for the locked one. (The confirm step re-reads the price from the 402 anyway,
 * and says so when the two disagree.)
 */
function OpenCallsDrilldown({
  slug,
  seriesTitle,
  calls,
  onClose,
}: {
  slug: string;
  seriesTitle: string;
  calls: OpenCallView[];
  onClose: () => void;
}) {
  /** Which call's checkout is open. One at a time — a buy is a modal act. */
  const [buying, setBuying] = useState<string | null>(null);
  // Only promise a buy when one is actually on offer. A full cohort, a closed
  // window or a deployment with no checkout all render this list unchanged, and
  // inviting a click that leads nowhere is worse than saying nothing.
  const anyBuyable = calls.some((c) => c.buyable);
  return (
    <section className="ck-frame m-2">
      <div className="ck-header">
        <h3 className="ck-title ck-title-ik">
          <Ik name="seal" /> open calls
        </h3>
        <span className="flex items-center gap-3">
          <span className="ck-mono ck-dim">
            {slug} · {seriesTitle} · locked price
            {anyBuyable ? " · click one to buy" : ""}
          </span>
          <button type="button" onClick={onClose} className="ck-btn ck-btn-bracket">
            close
          </button>
        </span>
      </div>
      <ul className="m-0 p-0 list-none">
        <li className="ck-matrix-calls ck-colhead px-2 py-1 border-b border-[var(--color-border-vis)]">
          <span
            title={
              "What checkout charges for THIS call, frozen when it was sealed." +
              (anyBuyable ? " A boxed price is one you can buy: click it." : "")
            }
          >
            locked price
          </span>
          <span>market</span>
          <span>seats</span>
          <span>sale closes</span>
        </li>
        {calls.map((call) => (
          <li key={call.onchainCallId} className="border-b border-[var(--color-border)]">
            <div className="ck-matrix-calls px-2 py-1">
              {/* The price cell IS the buy control when the call can be bought.
                  Fusing them is the point: an affordance that sits beside a
                  number can advertise a different one, and this one cannot. */}
              {call.buyable ? (
                <button
                  type="button"
                  onClick={() =>
                    setBuying((prev) => (prev === call.onchainCallId ? null : call.onchainCallId))
                  }
                  aria-expanded={buying === call.onchainCallId}
                  className={
                    "ck-mono ck-pos ck-matrix-open " +
                    (buying === call.onchainCallId ? "ck-matrix-open-on" : "")
                  }
                  title={`Buy early decrypt access to this call for ${call.lockedDisplay} ${call.currency.toUpperCase()} — the price locked when it was sealed, pricing ${call.pricingVersion} (${call.lockedPriceAtoms} atoms). The wallet that signs receives the access.`}
                >
                  {call.lockedDisplay} <span className="ck-dim">{call.currency.toUpperCase()}</span>
                </button>
              ) : (
                <span
                  className="ck-mono ck-pos"
                  title={`locked at seal time, pricing ${call.pricingVersion} — ${call.lockedPriceAtoms} atoms`}
                >
                  {call.lockedDisplay} <span className="ck-dim">{call.currency.toUpperCase()}</span>
                </span>
              )}
              <span
                className="ck-mono ck-matrix-truncate"
                title={call.question ?? `market ${call.marketId}`}
              >
                {call.question ?? (
                  <span className="ck-dim">
                    no published question · {shortId(call.marketId, 8, 4)}
                  </span>
                )}
              </span>
              <span className={"ck-mono " + (call.buyable ? "ck-tag-ok" : "ck-dim")}>
                {call.inventoryStatus === "checkout_unavailable"
                  ? "checkout unavailable"
                  : call.seatsLabel}
              </span>
              <span
                className="ck-mono ck-dim"
                title={formatLocalDateTime(call.saleClosesAt) ?? call.saleClosesAt}
              >
                {formatLocalTimeLabel(call.saleClosesAt) ?? UNLISTED}
              </span>
            </div>
            {buying === call.onchainCallId && (
              <Suspense fallback={<p className="px-2 pb-2 m-0 ck-mono ck-dim">loading checkout…</p>}>
                <BuyAccessPanel call={call} onClose={() => setBuying(null)} />
              </Suspense>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Same track count the loaded grid uses, so rows do not re-flow on landing. */
function MatrixSkeleton() {
  return (
    <div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[236px_repeat(4,minmax(0,1fr))] gap-1.5 px-2 py-1 border-b border-[var(--color-border)]"
        >
          <SkeletonBar className="h-[10px]" />
          <SkeletonBar className="h-[10px]" />
          <SkeletonBar className="h-[10px]" />
          <SkeletonBar className="h-[10px]" />
          <SkeletonBar className="h-[10px]" />
        </div>
      ))}
    </div>
  );
}
