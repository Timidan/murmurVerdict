import { useEffect, useRef, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { IkNav, type NavIconName } from "../../icons.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { MMark } from "../MMark.js";
import { MobileNav, isNavItemActive, type NavItem } from "./MobileNav.js";
import { NAV_CHORDS } from "./nav-chords.js";
import { formatLocalClock } from "../../lib/date-time-format.js";

interface CompactTopbarProps {
  /** Free-text crumb shown after the system identifier (e.g. "LB / TIER:ALL"). */
  crumb?: React.ReactNode;
  /** Receives the crumb slot element so pages can portal a crumb in. */
  crumbSlotRef?: (el: HTMLElement | null) => void;
}

/**
 * Primary nav — single source of truth for order. Rendered inline on the
 * desktop (≥1024px) topbar and, verbatim, inside the mobile <MobileNav/> panel.
 * `href` is the route path; anchors render it as a `#/…` hash link so nav
 * clicks stay in-app (no full reload, SSE connection survives) — the same
 * client-side navigation every data row already uses.
 */
const NAV_LINKS = [
  { href: "/dashboard", label: "dashboard" },
  { href: "/leaderboard", label: "leaderboard" },
  { href: "/today", label: "feed" },
  { href: "/install", label: "install" },
  { href: "/account", label: "account" },
] as const satisfies readonly NavItem[];

/** The routes above, as a union — the key type that makes NAV_ICONS total. */
type NavHref = (typeof NAV_LINKS)[number]["href"];

/**
 * Desktop nav glyphs, keyed by route so a reworded label can never silently
 * orphan its glyph. The desktop bar is icon-ONLY (owner amendment, 2026-08-07):
 * the label moves to `aria-label` plus a hover/focus tip, so this map is TOTAL —
 * every NAV_LINKS route must appear here or its link renders blank. Keying it
 * on `NavHref` (not `string`) makes the compiler enforce that: adding a nav
 * route without its glyph is now a type error, not a blank link at runtime. It
 * stays local to the desktop topbar on purpose: <MobileNav/> renders the same
 * NAV_LINKS as a text-only drawer list (small screens keep their words), and
 * NavItem stays icon-free so the two surfaces can't drift into needing the same
 * prop for different reasons.
 *
 * The values name glyphs on the NAV tier (24-grid, hairline-outline/fill pair)
 * — not the 16-grid inline set. The six concepts are spelled identically in
 * both tiers, so the type is what keeps this honest: `NavIconName` only admits
 * a name that NAV_GLYPHS actually draws.
 */
const NAV_ICONS: Record<NavHref, NavIconName> = {
  "/dashboard": "market",
  "/leaderboard": "leaderboard",
  "/today": "feed",
  "/install": "confirm-live",
  "/account": "agent",
};

/**
 * Route chords, keyed on route exactly like NAV_ICONS above: `g` then this key
 * jumps here. The bar only TEACHES the shortcut (in the nav tip); the listener
 * lives in <GlobalShortcuts/> at the router root, because the chords have to
 * work on surfaces that never render this bar.
 *
 * Both sides read the same `NAV_CHORDS` literal, so there is nothing to keep in
 * step by hand. This annotated assignment is the load-bearing line: widening
 * `NAV_CHORDS` to `Record<NavHref, string>` is what makes the map TOTAL over
 * the nav routes, so adding a route to NAV_LINKS without giving it a chord is a
 * type error here rather than a tip that silently reads "· gundefined".
 */
const CHORD_KEY: Record<NavHref, string> = NAV_CHORDS;

/**
 * Shared app chrome — 64px tall, single live-state dot, MMark glyph,
 * local clock, and the cinematic landing's canonical unboxed navigation.
 *
 * Below the `lg` breakpoint the inline nav links, clock and theme toggle
 * collapse into a menu drawer (see <MobileNav/>); the logo, live
 * status and menu trigger stay visible. The crumb slot truncates so no
 * breadcrumb (e.g. a full market id) can widen the document.
 */
export function CompactTopbar({ crumb, crumbSlotRef }: CompactTopbarProps) {
  const stream = useStream();
  const live = stream.status === "open";
  const [now, setNow] = useState(() => new Date());
  const currentPath = useActiveNavPath();

  // Columns-land activation (owner-approved motion, 2026-08-07): the newly
  // active link's fill assembles only on a route CHANGE. Initial mount keeps
  // stamp 0 so page load never animates (house rule); each change bumps the
  // stamp, which keys the active glyph so the CSS mount animation replays.
  const prevPath = useRef(currentPath);
  const [activationStamp, setActivationStamp] = useState(0);
  useEffect(() => {
    if (prevPath.current !== currentPath) {
      prevPath.current = currentPath;
      setActivationStamp((s) => s + 1);
    }
  }, [currentPath]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    /* `mmr-topbar` is the hook the hoverless branch needs: where the nav tips
       are pinned open they hang 34px below a 64px bar, so the bar grows to
       carry them and re-pins its rails to 64 (compact.css @media (hover: none)).
       Without a class there was no way to reach the header from CSS. */
    <header className="mmr-topbar h-[64px] flex items-stretch border-b border-[var(--color-border)] sticky top-0 z-30 bg-[var(--color-bg)]">
      {/* Equal-width rails + shrink-0 nav pin the glyph row to viewport centre.
          Dropping basis-0, or sizing the nav, re-opens a 65px per-route drift. */}
      <div className="flex-1 basis-0 min-w-0 flex items-center gap-2 pl-4 pr-3">
        <span
          aria-hidden
          className={
            "shrink-0 w-[5px] h-[5px] " +
            (live ? "bg-[var(--color-success)]" : "bg-[var(--color-accent)]")
          }
        />
        <a
          href="#/"
          className="mmr-hit shrink-0 no-underline flex items-center"
          aria-label="MURMUR.VERDICT — home"
        >
          <MMark size={28} decorative />
        </a>
        {crumb ? (
          <div className="mmr-topbar-crumb-slot min-w-0 ml-1 flex items-center lg:max-w-[360px] overflow-hidden">
            <span className="mmr-topbar-crumb truncate min-w-0">{crumb}</span>
          </div>
        ) : (
          <div
            ref={crumbSlotRef}
            className="mmr-topbar-crumb-slot mmr-topbar-crumb min-w-0 flex items-center lg:max-w-[360px] overflow-hidden truncate"
          />
        )}
      </div>
      <nav
        aria-label="Primary navigation"
        className="hidden lg:flex shrink-0 items-center justify-center mmr-nav-cluster px-4"
      >
        {NAV_LINKS.map((l) => (
          <CompactNavLink
            key={l.href}
            href={l.href}
            active={isNavItemActive(l.href, currentPath)}
            icon={NAV_ICONS[l.href]}
            label={l.label}
            activationStamp={activationStamp}
          />
        ))}
      </nav>
      {/* No min-w-0: squeezes are absorbed by the left rail's truncating crumb.
          Rail padding must stay equal both sides (28px) or the nav goes off-centre. */}
      <div className="flex-1 basis-0 flex h-full items-center justify-end gap-4 pl-3 pr-4">
        {/* Local, with its zone named. This printed UTC with a bare `Z` while
            every market window on the same screen was already rendered in the
            reader's own zone (lib/date-time-format.ts states that rule and the
            reason for it), so the cockpit carried two clocks hours apart and
            labelled neither. UTC keeps the place it belongs, which is the wire. */}
        <span
          aria-hidden="true"
          className="hidden lg:inline-flex mmr-topbar-meta ck-dim tabular-nums"
        >
          {formatLocalClock(now) ?? ""}
        </span>
        <div className="hidden lg:flex h-full items-center">
          <ThemeToggle />
        </div>
        <span
          role="status"
          aria-live="polite"
          className={"mmr-topbar-meta font-bold " + (live ? "ck-pos" : "ck-neg")}
        >
          {live
            ? "live"
            : stream.status === "closed"
              ? "offline"
              : "connecting"}
        </span>
        <div className="lg:hidden flex items-center h-full">
          {/* NAV_LINKS is a readonly tuple (see above); MobileNav takes a
              plain NavItem[], so hand it a mutable copy. */}
          <MobileNav links={[...NAV_LINKS]} currentPath={currentPath} />
        </div>
      </div>
    </header>
  );
}

/**
 * Current route path, normalized the same way route.ts resolves it: a legacy
 * `#/…` hash wins over the pathname, query string stripped. Kept in state and
 * refreshed on hashchange/popstate so the active nav marker follows in-app
 * (hash + back/forward) navigation without waiting on a full reload.
 */
function useActiveNavPath(): string {
  const [path, setPath] = useState(() => normalizeNavPath());
  useEffect(() => {
    const onNav = () => setPath(normalizeNavPath());
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, []);
  return path;
}

function normalizeNavPath(): string {
  const hashPath = window.location.hash.startsWith("#/")
    ? window.location.hash.slice(1)
    : "";
  const raw = hashPath || window.location.pathname || "/";
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  // /launch is the legacy clean-path alias for the canonical /install nav
  // destination; normalize it so the persistent active underline is honest.
  return path === "/launch" ? "/install" : path;
}

/**
 * One desktop nav destination: the glyph alone, drawn on the nav tier's native
 * 24 grid so it renders 1px-hard without `crispEdges`. The word it replaces
 * lives in two places — `aria-label` for assistive tech, and a bracketed tip
 * that fades in under the icon on hover/focus-visible (CSS only, see
 * `.mmr-nav-tip`). The tip is aria-hidden so the name is announced once — and
 * it is also where the route chord is taught (`· gd`), dimmed so the word
 * still reads first. `aria-label` stays the bare word: the chord is a visual
 * affordance for a pointer/keyboard user who can see the bar, not part of the
 * link's accessible name.
 *
 * `active` is the single route truth for this link: the same boolean drives
 * `aria-current="page"` (which the CSS underline keys off) and the glyph's
 * filled state, so the mark and the rule can never disagree about where you are.
 */
function CompactNavLink({
  href,
  active,
  icon,
  label,
  activationStamp = 0,
}: {
  /** Narrower than `string` so `CHORD_KEY[href]` is a total lookup. */
  href: NavHref;
  active?: boolean;
  icon: NavIconName;
  label: string;
  /** Bumped by the topbar on every route change; keys the active glyph so its
      columns-land assembly replays. 0 = initial load, which never animates. */
  activationStamp?: number;
}) {
  const activating = Boolean(active) && activationStamp > 0;
  return (
    <a
      href={`#${href}`}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      className={
        "mmr-nav-link mmr-nav-link--icon" +
        (activating ? " mmr-nav-link--activating" : "")
      }
    >
      <span key={active ? activationStamp : -1} className="mmr-nav-glyph">
        <IkNav name={icon} active={active} />
      </span>
      <span className="mmr-nav-tip" aria-hidden="true">
        {label}
        <span className="ck-dim"> · g{CHORD_KEY[href]}</span>
      </span>
    </a>
  );
}
