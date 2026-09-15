import { useEffect, useRef } from "react";
import { useStream } from "../hooks/useStream.js";
import { formatAtoms } from "../lib/atoms-format.js";

export function AnimatedLandingPage() {
  const { stats } = useStream();
  const frame = useRef<HTMLIFrameElement>(null);

  // The static iframe cannot read VITE_VERDICT_API_URL; this page's stream can.
  const postRecord = () => {
    if (!stats) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: "murmur:record",
        paid: formatAtoms(stats.provider_paid_usdc_atoms, "USDC"),
        sealed: stats.calls_sealed?.toLocaleString("en-US") ?? "—",
        agents: stats.agents_registered?.toLocaleString("en-US") ?? "—",
      },
      window.location.origin,
    );
  };
  useEffect(postRecord, [stats]);

  return (
    <iframe
      ref={frame}
      onLoad={postRecord}
      src="/landing-cinematic/index.html"
      title="Murmur Verdict"
      className="fixed inset-0 h-dvh w-full border-0 bg-black"
    />
  );
}
