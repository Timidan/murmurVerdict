import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readRouteQuery, buildRouteQueryUrl } from "../../route.js";
import { Ik, type IconName } from "../../icons.js";
import { PanelSkeleton } from "./PanelSkeleton.js";
import { useFocusTrap } from "./useFocusTrap.js";
import { sentenceCase, shortId } from "../../lib/display-format.js";

/**
 * Shared in-context detail drawer — a right sheet that shows an entity's detail
 * over whatever page you were on, instead of navigating to its full route.
 * Reached by left-clicking a row or a [V] verify chip; modifier/middle-clicks
 * and pasted links still open the full page (the canonical permalink).
 *
 * URL model — query-param overlay: opening pushes `?call=<id>` or
 * `?market=<id>` onto the current route so the background page never unmounts
 * and the browser Back button closes the drawer. A pasted `…?call=` / `…?market=`
 * link opens the drawer on load. pushState/replaceState don't fire hashchange,
 * so the drawer is React state here, synced to the URL — the hand-rolled hash
 * router (Router.tsx) never re-renders just to open it.
 *
 * Detail bodies are lazy-loaded so mounting the (always-present) drawer doesn't
 * pull the call/market page chunks into the initial bundle.
 */

type EntityKind = "call" | "market";
interface Entity {
  kind: EntityKind;
  id: string;
}

// One query param per kind. Only one drawer is ever open, so reads take the
// first present in this order and writes clear the others.
const PARAMS: EntityKind[] = ["call", "market"];

const LazyCallDetail = lazy(() =>
  import("./CallDetail.js").then((m) => ({ default: m.CallDetail })),
);
const LazyMarketDetail = lazy(() =>
  import("../../pages/MarketDetailPage.js").then((m) => ({ default: m.MarketDetailPage })),
);

function readEntity(): Entity | null {
  const q = readRouteQuery(window.location);
  for (const kind of PARAMS) {
    const id = q.get(kind);
    if (id) return { kind, id };
  }
  return null;
}

function urlWithEntity(entity: Entity | null): string {
  const q = readRouteQuery(window.location);
  for (const kind of PARAMS) q.delete(kind);
  if (entity) q.set(entity.kind, entity.id);
  return buildRouteQueryUrl(window.location, q);
}

interface DetailDrawerApi {
  entity: Entity | null;
  /** Open (or swap to) an entity in the drawer, syncing the URL param. */
  open: (kind: EntityKind, id: string) => void;
  /** Close the drawer and strip the entity param from the URL. */
  close: () => void;
}

const DetailDrawerContext = createContext<DetailDrawerApi | null>(null);

export function DetailDrawerProvider({ children }: { children: ReactNode }) {
  // Initialise from the URL so a pasted `…?call=` / `…?market=` link opens it.
  const [entity, setEntity] = useState<Entity | null>(() => readEntity());
  // Mirror read synchronously by open/close. The history side-effect lives here,
  // NOT inside a setState updater — React StrictMode double-invokes updaters,
  // which would push the param entry twice (Back would land on the copy).
  const entityRef = useRef<Entity | null>(entity);

  const open = useCallback((kind: EntityKind, id: string) => {
    const next = { kind, id };
    const url = urlWithEntity(next);
    // First open adds a history entry (so Back closes it); swapping while
    // already open just replaces it, so Back still closes the drawer rather
    // than stepping back through previously-viewed entities.
    if (entityRef.current) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    entityRef.current = next;
    setEntity(next);
  }, []);

  const close = useCallback(() => {
    if (entityRef.current) window.history.replaceState(null, "", urlWithEntity(null));
    entityRef.current = null;
    setEntity(null);
  }, []);

  // The URL is the source of truth for Back/forward + hash navigation: both
  // re-sync the drawer (and the ref). Navigating away via a nav link drops the
  // param → drawer closes.
  useEffect(() => {
    const sync = () => {
      const next = readEntity();
      entityRef.current = next;
      setEntity(next);
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const api = useMemo<DetailDrawerApi>(() => ({ entity, open, close }), [entity, open, close]);

  return (
    <DetailDrawerContext.Provider value={api}>{children}</DetailDrawerContext.Provider>
  );
}

export function useDetailDrawer(): DetailDrawerApi {
  const ctx = useContext(DetailDrawerContext);
  if (!ctx) throw new Error("useDetailDrawer must be used within DetailDrawerProvider");
  return ctx;
}

/**
 * True for a plain left-click that should be intercepted. Modifier/middle
 * clicks fall through to the anchor's href, so cmd/ctrl/middle-click still open
 * the full permalink in a new tab (keyboard + shareability preserved).
 */
export function isPlainLeftClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

const DRAWER_META: Record<
  EntityKind,
  { title: string; icon: IconName; permalink: (id: string) => string; maxW: string }
> = {
  call: { title: "call", icon: "verdict", permalink: (id) => `#/calls/${id}`, maxW: "max-w-[720px]" },
  market: { title: "market", icon: "market", permalink: (id) => `#/markets/${encodeURIComponent(id)}`, maxW: "max-w-[960px]" },
};

/**
 * The sheet itself. Mount once at the top level (Router). Renders nothing when
 * nothing is open. Drawer chrome mirrors MobileNav: backdrop + right panel,
 * Escape / backdrop / close-button dismissal, focus trap, focus return.
 */
export function DetailDrawer() {
  const { entity, close } = useDetailDrawer();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const open = entity !== null;

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, close]);

  // Keep Tab / Shift+Tab within the sheet. `open` is what re-binds the trap:
  // the panel is only in the DOM while an entity is open. Swapping entities
  // reuses the same node, so the binding survives it.
  useFocusTrap(panelRef, open);

  if (!entity) return null;
  const meta = DRAWER_META[entity.kind];

  return (
    // NB: the full-viewport root stays TRANSPARENT. `.mmr-shell` paints an
    // opaque page background, so it must live on the panel only — otherwise the
    // overlay blanks the page behind the scrim instead of dimming it.
    <div className="fixed inset-0 z-40">
      <div
        className="drawer-enter-backdrop absolute inset-0 bg-[var(--color-scrim)]"
        onClick={close}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${meta.title} ${entity.id.slice(0, 8)}`}
        className={
          "mmr-shell drawer-enter-panel absolute top-0 right-0 h-full w-full flex flex-col bg-[var(--color-bg)] border-l border-[var(--color-border)] " +
          meta.maxW
        }
      >
        <div className="ck-header shrink-0">
          {/* Title-marker upgrade (P2): the entity's own glyph replaces the
              generic ::before square, same as every panel title. */}
          <span className="ck-title ck-title-ik">
            <Ik name={meta.icon} /> {sentenceCase(meta.title)}
          </span>
          <span className="flex items-center gap-3">
            <span className="ck-mono ck-dim truncate max-w-[140px]" title={entity.id}>
              {shortId(entity.id, 8, 4)}
            </span>
            <a
              href={meta.permalink(entity.id)}
              className="ck-btn ck-btn-bracket no-underline"
              title="open the full page — this link is shareable"
            >
              open full page ↗
            </a>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              aria-label={`close ${meta.title} detail`}
              className="ck-btn ck-btn-bracket"
            >
              close
            </button>
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-auto overscroll-contain ck-scroll">
          <Suspense fallback={<PanelSkeleton rows={6} />}>
            {entity.kind === "call" && (
              <LazyCallDetail callId={entity.id} variant="drawer" />
            )}
            {entity.kind === "market" && (
              <LazyMarketDetail marketId={entity.id} variant="drawer" />
            )}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
