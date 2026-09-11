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

// account-area pages. Lazy so the Privy SDK chunk isn't pulled
// into the landing/leaderboard bundles.
const AccountPage = lazy(() => import("./pages/AccountPage.js").then((m) => ({ default: m.AccountPage })));
const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
// per-agent settings shell (payout + pricing + keys sub-tabs).
// The tab union is IMPORTED, not restated: a tab added to the page but
// missing from a local copy here would silently fall through to "payout".
import type { AgentSettingsTab } from "./pages/AgentSettingsPage.js";
import { LogoLoader } from "./components/LogoLoader.js";
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
const PrivacyPage = lazy(() =>
  import("./pages/PrivacyPage.js").then((m) => ({ default: m.PrivacyPage })),
);
// Real 404 — parseLocation's fallback for unknown URLs (route: not_found).
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage.js").then((m) => ({ default: m.NotFoundPage })),
);

/**
 * extract the `?next=` deep-link from the hash query string.
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

/** Routes with their own chrome — everything else wears the compact shell. */
const SHELL_LESS_ROUTES = new Set(["landing", "spec", "logo"]);

/** Content-area only; the shell around it never unmounts. */
function RouteFallback() {
  return <LogoLoader />;
}

/**
 * The missing safety net: without a boundary, ANY throw inside a lazy page —
 * a component bug, an unexpected API shape, or a stale chunk after a rebuild
 * changed the hashes — unmounts React to a silent white screen. "The page
 * sometimes blanks out on navigation" was this.
 *
 * Two recoveries, by cause:
 *   stale chunk (dynamic import failed)  → reload once, automatically. The
 *     fresh document loads the new hashes; a sessionStorage latch stops a
 *     broken deploy from looping the reload forever.
 *   anything else → say so, in words, with a reload control. A blank page
 *     tells the reader nothing; an error panel tells them it is not them.
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
    // Navigating away clears the error — the next page deserves a fresh try.
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
        {/* Dev only: a boundary that hides the error makes every crash a
            guessing game. Production keeps the plain sentence above. */}
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
 * Persistent app chrome. Mounted once, outside <Suspense>, so route changes swap
 * only the content: the topbar keeps its DOM node, its SSE subscription, and its
 * knowledge of the previous route (which is what makes the nav activation
 * animation fire at all).
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
      // A legacy `#/…` click lands here; fold it into the canonical path
      // BEFORE the key is read so the address bar never shows the doubled
      // `/dashboard#/dashboard` form. replaceState fires no events — no loop.
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
  // Stamped AFTER parseLocation, which runs after canonicalizeRouteLocation()
  // in the handler above — so a legacy `#/x` navigation never stamps a title
  // for the pre-canonical URL. Pages with richer data (a market's question)
  // refine it afterwards via setDocumentTitle.
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
            <IntegratePage slug={route.params!.slug} />
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
