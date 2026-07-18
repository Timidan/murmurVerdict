// dashboard/src/verdict/pages/LogoDemoPage.tsx
//
// Dev/review surface for AnimatedMark (route: /logo). Renders the component in
// both playback modes plus the Splash configuration (no wordmark) on the app
// background, so the full beat map can be eyeballed and captured mid-animation.
// Not linked from the app chrome — reachable only by URL.

import { useState } from "react";
import { AnimatedMark } from "../components/AnimatedMark.js";

export function LogoDemoPage() {
  // Remount trick: bump the key to restart the CSS keyframes from beat 1 so a
  // reviewer can replay the `once` assemble without a full page reload.
  const [replayKey, setReplayKey] = useState(0);

  return (
    <div
      className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-primary)] font-sans"
      style={{ padding: "48px 24px" }}
    >
      <div className="mx-auto max-w-[1100px]">
        <p className="t-label mb-2 text-[var(--color-secondary)]">demo</p>
        <h1 className="t-heading mb-2">AnimatedMark</h1>
        <p className="t-body-sm mb-8 max-w-[60ch]">
          CSS-keyframes logo animation. Beat map: hold → spin &amp; dissolve →
          respawn → swirl/orbit → converge → wordmark reveal → hold → loop.
          Honors
          <code className="font-mono text-[var(--color-display)]">
            {" "}
            prefers-reduced-motion
          </code>
          .
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "24px",
          }}
        >
          <DemoCell label='mode="once" · wordmark'>
            <AnimatedMark key={`once-${replayKey}`} size={120} mode="once" />
          </DemoCell>

          <DemoCell label='mode="loop" · wordmark'>
            <AnimatedMark size={120} mode="loop" />
          </DemoCell>

          <DemoCell label='mode="loop" · mark only (Splash config)'>
            <AnimatedMark size={120} mode="loop" showWordmark={false} />
          </DemoCell>
        </div>

        <button
          type="button"
          onClick={() => setReplayKey((k) => k + 1)}
          className="t-button press-feedback mt-8 inline-block border border-[var(--color-border-vis)] px-4 py-2 text-[var(--color-display)] hover:bg-[var(--color-surface)]"
        >
          replay once
        </button>
      </div>
    </div>
  );
}

function DemoCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="border border-[var(--color-border)]"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        gap: "20px",
        minHeight: "180px",
        padding: "32px 40px",
        background: "var(--color-bg)",
      }}
    >
      {children}
      <span className="t-meta text-[var(--color-secondary)]">{label}</span>
    </div>
  );
}
