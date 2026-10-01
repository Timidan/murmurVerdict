import { useEffect, useRef, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { IkNav, type NavIconName } from "../../icons.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { MMark } from "../MMark.js";
import { MobileNav, isNavItemActive, type NavItem } from "./MobileNav.js";
import { NAV_CHORDS } from "./nav-chords.js";

interface CompactTopbarProps {
  /** Free-text crumb shown after the system identifier (e.g. "LB / TIER:ALL"). */
  crumb?: React.ReactNode;
  /** Receives the crumb slot element so pages can portal a crumb in. */
  crumbSlotRef?: (el: HTMLElement | null) => void;
}

/**
 * Primary nav in order, shared by the desktop bar and <MobileNav/>. Rendered as
 * `#/…` hash links so navigation stays in-app and the SSE connection survives.
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
 * Desktop nav glyphs (icon-only bar, nav tier). Keyed on NavHref so a nav route
 * without a glyph is a type error, not a blank link.
 */
const NAV_ICONS: Record<NavHref, NavIconName> = {
  "/dashboard": "market",
  "/leaderboard": "leaderboard",
  "/today": "feed",
  "/install": "confirm-live",
  "/account": "agent",
};

/**
 * Chord keys shown in the nav tips; the listener is <GlobalShortcuts/>. Typed
 * on NavHref so a nav route without a chord is a type error.
 */
const CHORD_KEY: Record<NavHref, string> = NAV_CHORDS;

/**
 * Shared app chrome. Below `lg` the nav and theme toggle collapse into
 * <MobileNav/>; the crumb slot truncates so it can't widen the page.
 */
export function CompactTopbar({ crumb, crumbSlotRef }: CompactTopbarProps) {
  const stream = useStream();
  const live = stream.status === "open";
  const currentPath = useActiveNavPath();

  // Bumped on route change to replay the active glyph's animation; 0 on load.
  const prevPath = useRef(currentPath);
  const [activationStamp, setActivationStamp] = useState(0);
  useEffect(() => {
    if (prevPath.current !== currentPath) {
      prevPath.current = currentPath;
      setActivationStamp((s) => s + 1);
    }
  }, [currentPath]);

  return (
    /* `mmr-topbar` lets compact.css grow the bar for pinned tips on hoverless devices. */
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
        <div className="hidden lg:flex h-full items-center">
          <ThemeToggle />
        </div>
        <span
          role="status"
          aria-live="polite"
          className={"mmr-topbar-meta " + (live ? "ck-pos" : "ck-neg")}
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
 * Current route path normalized like route.ts (a `#/…` hash wins, query
 * stripped); follows hashchange/popstate.
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
 * One desktop nav link: glyph only. The word is the aria-label plus an
 * aria-hidden tip that also shows the chord. `active` drives both
 * aria-current and the filled glyph.
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
