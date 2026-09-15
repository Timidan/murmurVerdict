// Dev/review surface for AnimatedMark (route: /logo). Not linked from the app chrome.

import { useState } from "react";
import { AnimatedMark } from "../components/AnimatedMark.js";

export function LogoDemoPage() {
  // Bump the key to remount and replay the `once` animation.
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
