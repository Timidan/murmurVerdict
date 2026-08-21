// dashboard/src/verdict/components/Splash.tsx
//
// Full-bleed brand entrance: the logo sting, played once on a visitor's first
// landing-page load, then remembered. Dismisses on end, on any interaction,
// and on a hard timeout. Every other route relies on <LogoLoader/> instead.

import { useEffect, useRef, useState } from "react";
import { parseLocation } from "../route.js";

const SEEN_KEY = "murmur.sting.seen";
const STING_SRC = "/brand/logo-sting.mp4";
const STING_POSTER = "/brand/logo-sting-poster.png";
/** Sting runs 5.06s; cap well past it so a stalled decode can never trap anyone. */
const HARD_TIMEOUT_MS = 7000;
const FADE_MS = 320;

/** Landing route only — a deep link to /leaderboard should not sit through a
 *  sting. Resolved through the router's own parser: route.ts canonicalizes
 *  `#/x` to `/x` at module load, so a hash-only check here reads every deep
 *  link as an empty hash and plays the sting over it. */
function onLanding(): boolean {
  return parseLocation(window.location).name === "landing";
}

function alreadySeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // storage blocked — treat as seen rather than replaying every load
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* non-fatal */
  }
}

export function Splash() {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [active] = useState(() => onLanding() && !alreadySeen() && !reduced);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(active ? false : true);
  const dismissed = useRef(false);

  useEffect(() => {
    if (!active) {
      document.documentElement.removeAttribute("data-sting");
      return;
    }
    markSeen();

    const dismiss = () => {
      if (dismissed.current) return;
      dismissed.current = true;
      setLeaving(true);
      document.documentElement.removeAttribute("data-sting");
      window.setTimeout(() => setGone(true), FADE_MS);
    };

    const hard = window.setTimeout(dismiss, HARD_TIMEOUT_MS);
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, dismiss, { passive: true, once: true }));

    return () => {
      window.clearTimeout(hard);
      events.forEach((e) => window.removeEventListener(e, dismiss));
    };
  }, [active]);

  if (gone) return null;

  const end = () => {
    if (dismissed.current) return;
    dismissed.current = true;
    setLeaving(true);
    document.documentElement.removeAttribute("data-sting");
    window.setTimeout(() => setGone(true), FADE_MS);
  };

  return (
    <div
      role="status"
      aria-label="Murmur Verdict"
      className="mmr-sting"
      data-leaving={leaving ? "" : undefined}
      style={{ transition: `opacity ${FADE_MS}ms var(--ease-out)` }}
    >
      <video
        aria-hidden="true"
        src={STING_SRC}
        poster={STING_POSTER}
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={end}
        onError={end}
      />
      <button type="button" className="mmr-sting-skip" onClick={end}>
        skip
      </button>
    </div>
  );
}
