import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ThemeToggle } from "../ThemeToggle.js";
import { useFocusTrap } from "./useFocusTrap.js";

export interface NavItem {
  /** Route path (e.g. /leaderboard) — rendered as a `#/…` hash link. */
  href: string;
  label: string;
}

/** Exact match, or a sub-route of a non-root href (/account/agent/x → /account). */
export function isNavItemActive(href: string, current: string): boolean {
  if (current === href) return true;
  if (href !== "/" && current.startsWith(href + "/")) return true;
  return false;
}

/**
 * Mobile menu drawer, shown below `lg`. Closes on link, close, backdrop and
 * Escape; focus moves in on open and back to the trigger on close.
 */
export function MobileNav({
  links,
  currentPath,
}: {
  links: NavItem[];
  /** Normalized current path (pathname or legacy #/… hash) for active marking. */
  currentPath: string;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstLinkRef = useRef<HTMLAnchorElement | null>(null);
  const wasOpen = useRef(false);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Escape closes; focus moves into the panel on open and returns to the
  // trigger on close. One effect owns the whole open/close focus lifecycle.
  useEffect(() => {
    if (open) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      window.addEventListener("keydown", onKey);
      firstLinkRef.current?.focus();
      wasOpen.current = true;
      return () => window.removeEventListener("keydown", onKey);
    }
    if (wasOpen.current) {
      triggerRef.current?.focus();
      wasOpen.current = false;
    }
    return undefined;
  }, [open, close]);

  // Auto-close on route change. Nav links are hash links (handled by the
  // onClick below too), and browser back/forward is covered here.
  useEffect(() => {
    if (!open) return undefined;
    const onNav = () => close();
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, [open, close]);

  // Keep Tab / Shift+Tab within the open panel. `open` is what re-binds the
  // trap: the panel only exists in the DOM while the drawer is open.
  useFocusTrap(panelRef, open);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="menu"
        className="mmr-nav-link mmr-hit whitespace-nowrap"
      >
        menu
      </button>

      {open && (
        <div className="fixed inset-0 z-40">
          <div
            className="drawer-enter-backdrop absolute inset-0 bg-[var(--color-scrim)]"
            onClick={close}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label="menu"
            className="drawer-enter-panel absolute top-0 right-0 h-full w-[78%] max-w-[320px] flex flex-col bg-[var(--color-bg)] border-l border-[var(--color-border)]"
          >
            <div className="h-[64px] shrink-0 flex items-center justify-between border-b border-[var(--color-border)] px-4">
              <span className="mmr-topbar-meta ck-dim">navigation</span>
              <button
                type="button"
                onClick={close}
                aria-label="close menu"
                className="mmr-nav-link"
              >
                close
              </button>
            </div>
            <nav className="flex flex-col gap-1 p-4" aria-label="Mobile navigation">
              {links.map((l, i) => {
                const active = isNavItemActive(l.href, currentPath);
                return (
                  <a
                    key={l.href}
                    ref={i === 0 ? firstLinkRef : undefined}
                    href={`#${l.href}`}
                    onClick={close}
                    aria-current={active ? "page" : undefined}
                    className="mmr-nav-link mmr-nav-link--mobile"
                  >
                    {l.label}
                  </a>
                );
              })}
            </nav>
            <div className="mt-auto px-4 py-3 flex items-center justify-between border-t border-[var(--color-border)]">
              <span className="mmr-topbar-meta ck-dim">theme</span>
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
