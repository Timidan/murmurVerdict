import { useEffect, useState } from "react";
import { useStream } from "../../hooks/useStream.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { MMark } from "../MMark.js";
import { MobileNav, isNavItemActive, type NavItem } from "./MobileNav.js";

interface CompactTopbarProps {
  /** Free-text crumb shown after the system identifier (e.g. "LB / TIER:ALL"). */
  crumb?: React.ReactNode;
}

/**
 * Primary nav — single source of truth for order. Rendered inline on the
 * desktop (≥1024px) topbar and, verbatim, inside the mobile <MobileNav/> panel.
 * `href` is the route path; anchors render it as a `#/…` hash link so nav
 * clicks stay in-app (no full reload, SSE connection survives) — the same
 * client-side navigation every data row already uses.
 */
const NAV_LINKS: NavItem[] = [
  { href: "/dashboard", label: "dashboard" },
  { href: "/leaderboard", label: "leaderboard" },
  { href: "/today", label: "feed" },
  { href: "/install", label: "install" },
  { href: "/recruiters", label: "recruiters" },
  { href: "/account", label: "account" },
];

/**
 * Shared app chrome — 64px tall, single live-state dot, MMark glyph,
 * UTC clock, and the cinematic landing's canonical unboxed navigation.
 *
 * Below the `lg` breakpoint the inline nav links, clock and theme toggle
 * collapse into a menu drawer (see <MobileNav/>); the logo, live
 * status and menu trigger stay visible. The crumb slot truncates so no
 * breadcrumb (e.g. a full market id) can widen the document.
 */
export function CompactTopbar({ crumb }: CompactTopbarProps) {
  const stream = useStream();
  const live = stream.status === "open";
  const [now, setNow] = useState(() => new Date());
  const currentPath = useActiveNavPath();

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="h-[64px] flex items-stretch border-b border-[var(--color-border)] sticky top-0 z-30 bg-[var(--color-bg)]">
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-3">
        <span
          aria-hidden
          className={
            "w-[5px] h-[5px] " +
            (live ? "bg-[var(--color-success)] ck-dot-live" : "bg-[var(--color-accent)]")
          }
        />
        <a
          href="#/"
          className="no-underline flex items-center"
          aria-label="MURMUR.VERDICT — home"
        >
          <MMark size={28} decorative />
        </a>
      </div>
      {crumb && (
        <div className="min-w-0 flex flex-1 lg:flex-none lg:max-w-[360px] items-center pr-3 overflow-hidden">
          <span className="mmr-topbar-crumb truncate min-w-0">{crumb}</span>
        </div>
      )}
      <nav
        aria-label="Primary navigation"
        className="hidden lg:flex flex-1 items-center justify-center mmr-nav-cluster px-4"
      >
        {NAV_LINKS.map((l) => (
          <CompactNavLink
            key={l.href}
            href={l.href}
            active={isNavItemActive(l.href, currentPath)}
          >
            {l.label}
          </CompactNavLink>
        ))}
      </nav>
      <div className="ml-auto shrink-0 flex h-full items-center gap-4 pr-4">
        <span
          aria-hidden="true"
          className="hidden lg:inline-flex mmr-topbar-meta ck-dim tabular-nums"
        >
          {now.toISOString().slice(11, 19)}Z
        </span>
        <div className="hidden lg:flex h-full items-center">
          <ThemeToggle />
        </div>
        <span
          role="status"
          aria-live="polite"
          className={"mmr-topbar-meta font-bold " + (live ? "ck-pos" : "ck-neg")}
        >
          {live ? "live" : "offline"}
        </span>
        <div className="lg:hidden flex items-center h-full">
          <MobileNav links={NAV_LINKS} currentPath={currentPath} />
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

function CompactNavLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`#${href}`}
      aria-current={active ? "page" : undefined}
      className="mmr-nav-link"
    >
      {children}
    </a>
  );
}
