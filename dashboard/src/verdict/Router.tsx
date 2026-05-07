import { useEffect, useState, lazy, Suspense } from "react";

const VerdictLanding = lazy(() => import("./pages/Landing.js").then((m) => ({ default: m.VerdictLanding })));
const LeaderboardPage = lazy(() =>
  import("./pages/LeaderboardPage.js").then((m) => ({ default: m.LeaderboardPage })),
);
const TodayPage = lazy(() => import("./pages/TodayPage.js").then((m) => ({ default: m.TodayPage })));
const AgentPage = lazy(() => import("./pages/AgentPage.js").then((m) => ({ default: m.AgentPage })));
const CallPage = lazy(() => import("./pages/CallPage.js").then((m) => ({ default: m.CallPage })));
const ClaimPage = lazy(() => import("./pages/ClaimPage.js").then((m) => ({ default: m.ClaimPage })));
const LaunchPage = lazy(() => import("./pages/LaunchPage.js").then((m) => ({ default: m.LaunchPage })));
const SharePage = lazy(() => import("./pages/SharePage.js").then((m) => ({ default: m.SharePage })));
const RecruitersPage = lazy(() => import("./pages/RecruitersPage.js").then((m) => ({ default: m.RecruitersPage })));
const AdminRefsPage = lazy(() => import("./pages/AdminRefsPage.js").then((m) => ({ default: m.AdminRefsPage })));

interface ParsedRoute {
  name:
    | "landing"
    | "leaderboard"
    | "today"
    | "agent"
    | "agent_calls"
    | "call"
    | "claim"
    | "launch"
    | "share"
    | "recruiters"
    | "admin_refs"
    | "spec";
  params?: Record<string, string>;
}

function parseHash(hash: string): ParsedRoute {
  const raw = (hash || "#/").replace(/^#/, "");
  // Hash routes can carry their own query string (e.g.
  // `#/share/cred?ref=timidan` or `#/admin/refs?token=...`). Strip it before
  // pattern-matching so the slug capture doesn't pick up `?ref=…` etc.
  const qIdx = raw.indexOf("?");
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  if (path === "/" || path === "") return { name: "landing" };
  if (path === "/today") return { name: "today" };
  if (path === "/leaderboard") return { name: "leaderboard" };
  if (path === "/landing") return { name: "landing" };
  if (path === "/launch") return { name: "launch" };
  if (path === "/recruiters") return { name: "recruiters" };
  if (path === "/admin/refs") return { name: "admin_refs" };
  if (path === "/spec") return { name: "spec" };
  const shareMatch = /^\/share\/([^/]+)$/.exec(path);
  if (shareMatch) return { name: "share", params: { slug: shareMatch[1] } };
  const callMatch = /^\/calls\/(.+)$/.exec(path);
  if (callMatch) return { name: "call", params: { call_id: callMatch[1] } };
  const claimMatch = /^\/agents\/([^/]+)\/claim$/.exec(path);
  if (claimMatch) return { name: "claim", params: { slug: claimMatch[1] } };
  const agentCalls = /^\/agents\/([^/]+)\/calls$/.exec(path);
  if (agentCalls) return { name: "agent_calls", params: { slug: agentCalls[1] } };
  const agent = /^\/agents\/([^/]+)$/.exec(path);
  if (agent) return { name: "agent", params: { slug: agent[1] } };
  return { name: "landing" };
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
    <Suspense fallback={<div className="min-h-dvh bg-[var(--color-bg)]" />}>
      {route.name === "landing" && <VerdictLanding />}
      {route.name === "leaderboard" && <LeaderboardPage />}
      {route.name === "today" && <TodayPage />}
      {route.name === "agent" && <AgentPage slug={route.params!.slug} />}
      {route.name === "agent_calls" && <AgentPage slug={route.params!.slug} />}
      {route.name === "call" && <CallPage callId={route.params!.call_id} />}
      {route.name === "claim" && <ClaimPage slug={route.params!.slug} />}
      {route.name === "launch" && <LaunchPage />}
      {route.name === "share" && <SharePage slug={route.params!.slug} />}
      {route.name === "recruiters" && <RecruitersPage />}
      {route.name === "admin_refs" && <AdminRefsPage />}
      {route.name === "spec" && <SpecPage />}
    </Suspense>
  );
}

function SpecPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-primary)] font-sans">
      <div className="mx-auto max-w-[960px] px-6 md:px-10 py-16">
        <p className="t-label mb-3 text-[var(--color-secondary)]">spec</p>
        <h1 className="t-heading mb-6">murmur verdict v0.1</h1>
        <p className="t-body max-w-[60ch]">
          See <code className="font-mono text-[var(--color-display)]">docs/launchpad/THESIS.md</code> in the repo for the frozen
          v0.1 specification.
        </p>
        <a href="#/" className="t-button text-[var(--color-display)] mt-8 inline-block hover:underline">
          ← back home
        </a>
      </div>
    </div>
  );
}
