// dashboard/src/verdict/components/Splash.tsx
//
// Full-bleed first-paint splash. Fades out (200ms) after the first
// post-hydration frame, then unmounts.
// Renders AnimatedMark (mode="once", no wordmark) — the mark's own motion is
// gated on prefers-reduced-motion inside animated-mark.css.

import { useEffect, useState } from "react";
import { AnimatedMark } from "./AnimatedMark.js";

export function Splash() {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setLeaving(true));
    // Fallback in case transitionend is swallowed (tab hidden, etc.).
    const fallback = setTimeout(() => setGone(true), 400);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(fallback);
    };
  }, []);

  if (gone) return null;

  return (
    <div
      role="status"
      aria-label="Loading Murmur Verdict"
      onTransitionEnd={() => setGone(true)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "var(--color-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        opacity: leaving ? 0 : 1,
        transition: "opacity 200ms var(--ease-out)",
      }}
    >
      <AnimatedMark size={96} mode="once" showWordmark={false} />
    </div>
  );
}
