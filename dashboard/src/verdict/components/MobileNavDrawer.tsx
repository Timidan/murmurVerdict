import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Mobile hamburger drawer for the default <Topbar />.
 *
 * Spec: docs/superpowers/specs/2026-05-20-mobile-hamburger-nav-design.md
 *
 * Behavior contract (locked):
 *   - Trigger sized 32x32, hidden ≥768px via `md:hidden`. Glyph is a
 *     hand-rolled inline SVG: three 1px horizontal strokes when closed,
 *     two rotated strokes (×) when open. No icon library.
 *   - Sheet is `position: absolute` pinned beneath the 38px topbar at
 *     `top: 38px`, full-width, opaque `--color-bg`, same border tone.
 *     Animates in via `translateY(-100%) → 0` over 180ms with the
 *     Nothing ease-out token from styles.css.
 *   - `prefers-reduced-motion: reduce` → 0ms transition (instant snap).
 *   - Closes on: tap on any row link, hashchange, popstate, tap outside
 *     the sheet, Escape, and the [×] trigger.
 *   - role="dialog" + aria-modal="false" (no focus trap, no scrim).
 *   - Auth row 5 (`#/account`) is a dumb deep-link; NO usePrivy here
 *     because PrivyProvider is route-gated behind <AccountShell>.
 */

interface NavRow {
  label: string;
  href: string;
  /** When true, render as the outlined INSTALL button instead of a plain row. */
  button?: boolean;
}

const ROWS: NavRow[] = [
  { label: "leaderboard", href: "#/leaderboard" },
  { label: "today", href: "#/today" },
  { label: "recruiters", href: "#/recruiters" },
  { label: "install", href: "#/launch", button: true },
  { label: "account", href: "#/account" },
];

export function MobileNavDrawer() {
  const [open, setOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const sheetId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  // prefers-reduced-motion: collapse transition to 0ms on `reduce`.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(mq.matches);
    sync();
    if (mq.addEventListener) {
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
    // Safari < 14 fallback
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, []);

  // Auto-close on route change (hash or history nav).
  useEffect(() => {
    if (!open) return;
    const handler = () => close();
    window.addEventListener("hashchange", handler);
    window.addEventListener("popstate", handler);
    return () => {
      window.removeEventListener("hashchange", handler);
      window.removeEventListener("popstate", handler);
    };
  }, [open, close]);

  // Escape closes; tap-outside closes (tap on page content below sheet).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sheetRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    // pointerdown so taps on the underlying page register before any
    // click handlers there fire — feels native, matches sheet semantics.
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  const transitionMs = reducedMotion ? 0 : 180;
  // The sheet is mounted always so the open→close transition can play
  // out. Visibility is driven by transform + aria-hidden.
  return (
    <div className="md:hidden">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={sheetId}
        aria-label={open ? "close menu" : "open menu"}
        className="inline-flex items-center justify-center w-8 h-8 ml-1 -mr-1 text-[var(--color-display)] press-feedback"
      >
        <HamburgerGlyph open={open} />
      </button>
      <div
        ref={sheetRef}
        id={sheetId}
        role="dialog"
        aria-modal="false"
        aria-hidden={!open}
        className={
          "absolute left-0 right-0 top-[38px] " +
          "bg-[var(--color-bg)] border-b border-[var(--color-border)] " +
          "overflow-hidden z-30"
        }
        style={{
          transform: open ? "translateY(0)" : "translateY(-100%)",
          transition: `transform ${transitionMs}ms var(--ease-out)`,
          // Prevent the (hidden) sheet from intercepting pointer events
          // when closed — otherwise it would steal taps from the page.
          pointerEvents: open ? "auto" : "none",
        }}
      >
        <div className="flex flex-col">
          {ROWS.map((row) =>
            row.button ? (
              <div key={row.label} className="px-4 py-3">
                <a
                  href={row.href}
                  onClick={close}
                  className="t-button block text-center border border-[var(--color-display)] text-[var(--color-display)] px-3 py-2 hover:bg-[var(--color-display)] hover:text-[var(--color-bg)] transition-colors duration-150 ease-out press-feedback no-underline"
                >
                  INSTALL
                </a>
              </div>
            ) : (
              <a
                key={row.label}
                href={row.href}
                onClick={close}
                className="t-meta flex items-center h-12 px-4 text-[var(--color-secondary)] hover:text-[var(--color-display)] no-underline border-t border-[var(--color-border)] first:border-t-0"
              >
                {row.label}
              </a>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function HamburgerGlyph({ open }: { open: boolean }) {
  // 16x16 viewBox keeps strokes crisp inside the 32x32 button. Three
  // 1px strokes when closed (16px wide, 4px vertical gap → rows at
  // y=4, 8, 12). When open, swap to two rotated strokes forming ×.
  const stroke = "currentColor";
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {open ? (
        <>
          <line x1={2} y1={2} x2={14} y2={14} stroke={stroke} strokeWidth={1} />
          <line x1={14} y1={2} x2={2} y2={14} stroke={stroke} strokeWidth={1} />
        </>
      ) : (
        <>
          <line x1={0} y1={4} x2={16} y2={4} stroke={stroke} strokeWidth={1} />
          <line x1={0} y1={8} x2={16} y2={8} stroke={stroke} strokeWidth={1} />
          <line x1={0} y1={12} x2={16} y2={12} stroke={stroke} strokeWidth={1} />
        </>
      )}
    </svg>
  );
}
