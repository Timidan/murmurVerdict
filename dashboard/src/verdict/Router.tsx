import React, { useEffect, useState, lazy, Suspense } from "react";
import { canonicalizeRouteLocation, parseLocation } from "./route.js";
import { applyRouteMeta, routeMeta } from "./lib/route-meta.js";
import { DetailDrawerProvider, DetailDrawer, useDetailDrawer } from "./components/compact/DetailDrawer.js";
import { GlobalShortcuts } from "./components/compact/GlobalShortcuts.js";
// Static, not lazy: a lazy topbar would suspend the fallback that renders it.
import { CompactTopbar } from "./components/compact/Topbar.js";
import { CompactFooter } from "./components/compact/Footer.js";
import { CrumbSlotContext } from "./components/compact/TopbarCrumb.js";

const TodayPage = lazy(() => import("./pages/TodayPage.js").then((m) => ({ default: m.TodayPage })));
const CallPage = lazy(() => import("./pages/CallPage.js").then((m) => ({ default: m.CallPage })));
const SharePage = lazy(() => import("./pages/SharePage.js").then((m) => ({ default: m.SharePage })));
const RecruitersPage = lazy(() => import("./pages/RecruitersPage.js").then((m) => ({ default: m.RecruitersPage })));
const AdminRefsPage = lazy(() => import("./pages/AdminRefsPage.js").then((m) => ({ default: m.AdminRefsPage })));
const AdminGatewayPage = lazy(() => import("./pages/AdminGatewayPage.js").then((m) => ({ default: m.AdminGatewayPage })));
const AdminOverviewPage = lazy(() => import("./pages/AdminOverviewPage.js").then((m) => ({ default: m.AdminOverviewPage })));

// Account-area pages; lazy so the Privy SDK stays out of public bundles.
const AccountPage = lazy(() => import("./pages/AccountPage.js").then((m) => ({ default: m.AccountPage })));
const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
// Tab union is imported, not restated, so a new tab can't silently fall through to "payout".
import type { AgentSettingsTab } from "./pages/AgentSettingsPage.js";
import { LogoLoader } from "./components/LogoLoader.js";
const AgentSettingsPage = lazy(() =>
  import("./pages/AgentSettingsPage.js").then((m) => ({
    default: m.AgentSettingsPage,
  })),
);
const IntegratePage = lazy(() =>
  import("./pages/IntegratePage.js").then((m) => ({ default: m.IntegratePage })),
);
const AgentOnboardPage = lazy(() =>
  import("./pages/AgentOnboardPage.js").then((m) => ({
    default: m.AgentOnboardPage,
  })),
);
// One AccountShell wraps every /account/* route so auth state survives navigation.
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
const PrivacyPage = lazy(() =>
  import("./pages/PrivacyPage.js").then((m) => ({ default: m.PrivacyPage })),
);
// Real 404 — parseLocation's fallback for unknown URLs (route: not_found).
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage.js").then((m) => ({ default: m.NotFoundPage })),
);

/** Raw (un-decoded) `?next=` value from the hash query; never throws. */
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

/** Routes with their own chrome — everything else wears the compact shell. */
const SHELL_LESS_ROUTES = new Set(["landing", "spec", "logo"]);

/** Content-area only; the shell around it never unmounts. */
function RouteFallback() {
  return <LogoLoader />;
}

/**
 * Catches page render errors. A stale chunk reloads once (sessionStorage latch
 * stops a reload loop); anything else shows an error panel with a reload button.
 */
class RouteErrorBoundary extends React.Component<
  { locationKey: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { locationKey: string }) {
    // Navigating away clears the error.
    if (prev.locationKey !== this.props.locationKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error) {
    const staleChunk = /dynamically imported module|Loading chunk|Failed to fetch/i.test(
      String(error?.message ?? error),
    );
    if (staleChunk && !sessionStorage.getItem("mmr_chunk_reloaded")) {
      sessionStorage.setItem("mmr_chunk_reloaded", "1");
      window.location.reload();
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-6 ck-mono text-[12px] flex flex-col gap-2 items-start">
        <span className="ck-neg">this page hit an error while rendering.</span>
        <span className="ck-dim">
          It is not you — the page broke. The rest of murmur still works.
        </span>
        {/* Stack trace in dev only. */}
        {import.meta.env.DEV && (
          <pre className="ck-neg whitespace-pre-wrap break-all max-w-[90ch] leading-tight">
            {this.state.error.stack ?? String(this.state.error)}
          </pre>
        )}
        <button
          type="button"
          className="ck-btn ck-btn-bracket"
          onClick={() => window.location.reload()}
        >
          reload the page
        </button>
      </div>
    );
  }
}

/**
 * Persistent app chrome, mounted outside <Suspense> so the topbar keeps its DOM,
 * SSE subscription, and previous route (needed for the nav animation).
 */
function AppShell({ shellLess, children }: { shellLess: boolean; children: React.ReactNode }) {
  const [crumbSlot, setCrumbSlot] = useState<HTMLElement | null>(null);
  if (shellLess) return <>{children}</>;
  return (
    <CrumbSlotContext.Provider value={crumbSlot}>
      <div className="mmr-shell min-h-dvh bg-[var(--color-bg)] flex flex-col">
        <CompactTopbar crumbSlotRef={setCrumbSlot} />
        {children}
        <CompactFooter />
      </div>
    </CrumbSlotContext.Provider>
  );
}

export function VerdictRouter() {
  const [locationKey, setLocationKey] = useState(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  useEffect(() => {
    const onLocation = () => {
      // Canonicalize legacy `#/…` URLs before reading the key; replaceState fires no events.
      canonicalizeRouteLocation();
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
  // Must run after canonicalization; pages may refine the title via setDocumentTitle.
  useEffect(() => {
    applyRouteMeta(routeMeta(route));
  }, [route.name, route.params?.slug, route.params?.id]);
  const next = parseNext(window.location.hash || window.location.search);

  return (
    <DetailDrawerProvider>
    <BackgroundInert>
    <AppShell shellLess={SHELL_LESS_ROUTES.has(route.name)}>
    <RouteErrorBoundary locationKey={locationKey}>
    <Suspense fallback={<RouteFallback />}>
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
      {route.name === "privacy" && <PrivacyPage />}
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
            <IntegratePage key={route.params!.slug} slug={route.params!.slug} />
          )}
          {route.name === "agent_onboard" && <AgentOnboardPage />}
        </AccountShell>
      )}
      {route.name === "spec" && <SpecPage />}
      {route.name === "logo" && <LogoDemoPage />}
      {route.name === "not_found" && <NotFoundPage path={route.params?.path} />}
    </Suspense>
    </RouteErrorBoundary>
    </AppShell>
    </BackgroundInert>
      {/* Route chords (`g` + key); must sit outside <BackgroundInert/> to work while the drawer is open. */}
      <GlobalShortcuts />
      <DetailDrawer />
    </DetailDrawerProvider>
  );
}

/** Marks the page `inert` while the detail drawer is open, hiding it from tab order and screen readers. */
function BackgroundInert({ children }: { children: React.ReactNode }) {
  const { entity } = useDetailDrawer();
  return <div inert={entity !== null || undefined}>{children}</div>;
}

/** Decode `?next=`; malformed percent sequences give null so LoginPage defaults to /account. */
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
          Dev-only placeholder. Production builds route /spec to the 404 page.
        </p>
        <a href="#/" className="t-button text-[var(--color-display)] mt-8 inline-block hover:underline">
          ← back home
        </a>
      </div>
    </div>
  );
}
