import { useEffect, useState, lazy, Suspense } from "react";
import { parseLocation } from "./route.js";
import { DetailDrawerProvider, DetailDrawer, useDetailDrawer } from "./components/compact/DetailDrawer.js";
import { GlobalShortcuts } from "./components/compact/GlobalShortcuts.js";

const TodayPage = lazy(() => import("./pages/TodayPage.js").then((m) => ({ default: m.TodayPage })));
const CallPage = lazy(() => import("./pages/CallPage.js").then((m) => ({ default: m.CallPage })));
const SharePage = lazy(() => import("./pages/SharePage.js").then((m) => ({ default: m.SharePage })));
const RecruitersPage = lazy(() => import("./pages/RecruitersPage.js").then((m) => ({ default: m.RecruitersPage })));
const AdminRefsPage = lazy(() => import("./pages/AdminRefsPage.js").then((m) => ({ default: m.AdminRefsPage })));
const AdminGatewayPage = lazy(() => import("./pages/AdminGatewayPage.js").then((m) => ({ default: m.AdminGatewayPage })));
const AdminOverviewPage = lazy(() => import("./pages/AdminOverviewPage.js").then((m) => ({ default: m.AdminOverviewPage })));

// Phase 7a — account-area pages. Lazy so the Privy SDK chunk isn't pulled
// into the landing/leaderboard bundles.
const AccountPage = lazy(() => import("./pages/AccountPage.js").then((m) => ({ default: m.AccountPage })));
const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
// Phase 7c — per-agent settings shell (payout + pricing + keys sub-tabs).
// The tab union is IMPORTED, not restated: a tab added to the page but
// missing from a local copy here would silently fall through to "payout".
import type { AgentSettingsTab } from "./pages/AgentSettingsPage.js";
const AgentSettingsPage = lazy(() =>
  import("./pages/AgentSettingsPage.js").then((m) => ({
    default: m.AgentSettingsPage,
  })),
);
// Per-agent integration snippet view. Renders the CodeSnippetPanel keyed
// to the agent + reads the most-recently-minted api-key secret out of
// the sessionStorage handoff dropped by ApiKeyMintModal (mint flow now
// lives under the /keys settings tab; the page falls back to a
// secret-redacted snippet when no fresh secret is stashed).
const IntegratePage = lazy(() =>
  import("./pages/IntegratePage.js").then((m) => ({ default: m.IntegratePage })),
);
// Primary new-agent surface — slug input + in-browser signing flow that
// chains create-agent → controller-wallet bind → runtime-key mint and
// surfaces the runtime key once via RuntimeKeyMintModal.
const AgentOnboardPage = lazy(() =>
  import("./pages/AgentOnboardPage.js").then((m) => ({
    default: m.AgentOnboardPage,
  })),
);
// PrivyProvider mounts here, not in main.tsx, so public routes never load
// the Privy SDK. One AccountShell instance wraps every /account/* route so
// auth state survives navigation between login → list → onboarding/settings.
const AccountShell = lazy(() => import("./auth/AccountShell.js").then((m) => ({ default: m.AccountShell })));

const LandingPage = lazy(() =>
  import("./pages/LandingPage.js").then((m) => ({ default: m.LandingPage })),
);
const AnimatedLandingPage = lazy(() =>
  import("./pages/AnimatedLandingPage.js").then((m) => ({ default: m.AnimatedLandingPage })),
);
const LeaderboardPage = lazy(() =>
  import("./pages/LeaderboardPage.js").then((m) => ({ default: m.LeaderboardPage })),
);
const LaunchPage = lazy(() =>
  import("./pages/LaunchPage.js").then((m) => ({ default: m.LaunchPage })),
);
const MarketDetailPage = lazy(() =>
  import("./pages/MarketDetailPage.js").then((m) => ({ default: m.MarketDetailPage })),
);
const AgentPage = lazy(() =>
  import("./pages/AgentPage.js").then((m) => ({ default: m.AgentPage })),
);
// Dev/review-only surface for the AnimatedMark logo (route: /logo).
const LogoDemoPage = lazy(() =>
  import("./pages/LogoDemoPage.js").then((m) => ({ default: m.LogoDemoPage })),
);
// Real 404 — parseLocation's fallback for unknown URLs (route: not_found).
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage.js").then((m) => ({ default: m.NotFoundPage })),
);

/**
 * Phase 7a — extract the `?next=` deep-link from the hash query string.
 * Returns the raw (un-decoded) path so LoginPage can sanitize it before
 * navigation. Defensive URL parsing — no throws on malformed input.
 */
function parseNext(hash: string): string | null {
  const raw = (hash || "").replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.slice(qIdx + 1));
  } catch {
    return null;
  }
  const n = params.get("next");
  return n && n.length > 0 ? n : null;
}

export function VerdictRouter() {
  const [locationKey, setLocationKey] = useState(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  useEffect(() => {
    const onLocation = () => {
      setLocationKey(`${window.location.pathname}${window.location.search}${window.location.hash}`);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onLocation);
    window.addEventListener("popstate", onLocation);
    return () => {
      window.removeEventListener("hashchange", onLocation);
      window.removeEventListener("popstate", onLocation);
    };
  }, []);

  void locationKey;
  const route = parseLocation(window.location);
  const next = parseNext(window.location.hash || window.location.search);

  return (
    <DetailDrawerProvider>
    <BackgroundInert>
    <Suspense
      fallback={
        <div className="mmr-shell min-h-dvh bg-[var(--color-bg)] flex items-center justify-center">
          <span className="ck-mono ck-dim">loading…</span>
        </div>
      }
    >
      {route.name === "landing" && <AnimatedLandingPage />}
      {route.name === "dashboard" && <LandingPage />}
      {route.name === "leaderboard" && <LeaderboardPage />}
      {route.name === "today" && <TodayPage />}
      {route.name === "agent" && <AgentPage slug={route.params!.slug} />}
      {route.name === "agent_calls" && <AgentPage slug={route.params!.slug} />}
      {route.name === "call" && <CallPage callId={route.params!.call_id} />}
      {route.name === "launch" && <LaunchPage />}
      {route.name === "share" && <SharePage slug={route.params!.slug} />}
      {route.name === "recruiters" && <RecruitersPage />}
      {route.name === "admin_refs" && <AdminRefsPage />}
      {route.name === "admin_gateway" && <AdminGatewayPage />}
      {route.name === "admin_overview" && <AdminOverviewPage />}
      {route.name === "market" && <MarketDetailPage marketId={route.params!.market_id} />}
      {(route.name === "account" ||
        route.name === "account_login" ||
        route.name === "account_agent_settings" ||
        route.name === "account_agent_integrate" ||
        route.name === "agent_onboard") && (
        <AccountShell>
          {route.name === "account" && <AccountPage />}
          {route.name === "account_login" && <LoginPage next={decodeNext(next)} />}
          {route.name === "account_agent_settings" && (
            <AgentSettingsPage
              slug={route.params!.slug}
              tab={(route.params!.tab as AgentSettingsTab) ?? "payout"}
            />
          )}
          {route.name === "account_agent_integrate" && (
            <IntegratePage slug={route.params!.slug} />
          )}
          {route.name === "agent_onboard" && <AgentOnboardPage />}
        </AccountShell>
      )}
      {route.name === "spec" && <SpecPage />}
      {route.name === "logo" && <LogoDemoPage />}
      {route.name === "not_found" && <NotFoundPage path={route.params?.path} />}
    </Suspense>
    </BackgroundInert>
      {/* Route chords (`g` + key). Mounted here, once, as a sibling of the
          drawer: it renders nothing and listens on `window`, so it must sit
          outside <BackgroundInert/> — an inert subtree is exactly what the
          keyboard layer should still work behind. */}
      <GlobalShortcuts />
      <DetailDrawer />
    </DetailDrawerProvider>
  );
}

/**
 * While the detail drawer is open, mark the page behind it `inert` so the
 * background is removed from the tab order AND the screen-reader tree — the
 * drawer's focus trap alone keeps Tab inside, but without inert a virtual
 * cursor could still wander the dimmed page. The drawer itself renders as a
 * sibling, outside this wrapper.
 */
function BackgroundInert({ children }: { children: React.ReactNode }) {
  const { entity } = useDetailDrawer();
  return <div inert={entity !== null || undefined}>{children}</div>;
}

/**
 * Decode the `?next=` query value with the same defensive posture as the
 * market_id decoder above. Malformed percent sequences fall back to null,
 * so LoginPage cleanly defaults to /account.
 */
function decodeNext(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function SpecPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-bg)] text-[var(--color-primary)] font-sans brand-pattern">
      <div className="mx-auto max-w-[960px] px-6 md:px-10 py-16">
        <p className="t-label mb-3 text-[var(--color-secondary)]">spec</p>
        <h1 className="t-heading mb-6" style={{ textWrap: "balance" }}>murmur verdict v0.1</h1>
        <p className="t-body max-w-[60ch]">
          See <code className="font-mono text-[var(--color-display)]">CONTEXT.md</code> and{" "}
          <code className="font-mono text-[var(--color-display)]">HANDOFF.md</code> in
          the repo for the current system map and implementation handoff.
        </p>
        <a href="#/" className="t-button text-[var(--color-display)] mt-8 inline-block hover:underline">
          ← back home
        </a>
      </div>
    </div>
  );
}
