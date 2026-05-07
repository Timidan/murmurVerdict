import { useEffect, useState, lazy, Suspense } from "react";

const LeaderboardPage = lazy(() =>
  import("./pages/LeaderboardPage.js").then((m) => ({ default: m.LeaderboardPage })),
);
const TodayPage = lazy(() => import("./pages/TodayPage.js").then((m) => ({ default: m.TodayPage })));
const VerdictLanding = lazy(() => import("./pages/Landing.js").then((m) => ({ default: m.VerdictLanding })));
const AgentPage = lazy(() => import("./pages/AgentPage.js").then((m) => ({ default: m.AgentPage })));
const CallPage = lazy(() => import("./pages/CallPage.js").then((m) => ({ default: m.CallPage })));
const ClaimPage = lazy(() => import("./pages/ClaimPage.js").then((m) => ({ default: m.ClaimPage })));

interface ParsedRoute {
  name: "leaderboard" | "today" | "landing" | "agent" | "agent_calls" | "call" | "claim" | "spec";
  params?: Record<string, string>;
}

function parseHash(hash: string): ParsedRoute {
  const path = (hash || "#/").replace(/^#/, "");
  if (path === "/" || path === "") return { name: "today" };
  if (path === "/today") return { name: "today" };
  if (path === "/leaderboard") return { name: "leaderboard" };
  if (path === "/landing") return { name: "landing" };
  if (path === "/spec") return { name: "spec" };
  const callMatch = /^\/calls\/(.+)$/.exec(path);
  if (callMatch) return { name: "call", params: { call_id: callMatch[1] } };
  const claimMatch = /^\/agents\/([^/]+)\/claim$/.exec(path);
  if (claimMatch) return { name: "claim", params: { slug: claimMatch[1] } };
  const agentCalls = /^\/agents\/([^/]+)\/calls$/.exec(path);
  if (agentCalls) return { name: "agent_calls", params: { slug: agentCalls[1] } };
  const agent = /^\/agents\/([^/]+)$/.exec(path);
  if (agent) return { name: "agent", params: { slug: agent[1] } };
  return { name: "today" };
}

export function VerdictRouter() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const route = parseHash(hash);

  return (
    <Suspense fallback={<div className="min-h-dvh bg-[var(--color-canvas)]" />}>
      {route.name === "leaderboard" && <LeaderboardPage />}
      {route.name === "today" && <TodayPage />}
      {route.name === "landing" && <VerdictLanding />}
      {route.name === "agent" && <AgentPage slug={route.params!.slug} />}
      {route.name === "agent_calls" && <AgentPage slug={route.params!.slug} />}
      {route.name === "call" && <CallPage callId={route.params!.call_id} />}
      {route.name === "claim" && <ClaimPage slug={route.params!.slug} />}
      {route.name === "spec" && <SpecPage />}
    </Suspense>
  );
}

function SpecPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] text-[var(--color-ink)] font-sans">
      <div className="mx-auto max-w-[1280px] px-6 md:px-8 py-16">
        <h1 className="t-display-md mb-4">Spec</h1>
        <p className="t-body text-[var(--color-ink-muted)]">
          See <code className="t-mono">docs/launchpad/THESIS.md</code> in the repo for the frozen v0.1 specification.
        </p>
        <a href="#/" className="t-button text-[var(--color-primary)] mt-6 inline-block">← back to leaderboard</a>
      </div>
    </div>
  );
}
