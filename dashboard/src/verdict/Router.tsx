import { useEffect, useState, lazy, Suspense } from "react";

const TodayPage = lazy(() => import("./pages/TodayPage.js").then((m) => ({ default: m.TodayPage })));
const CallPage = lazy(() => import("./pages/CallPage.js").then((m) => ({ default: m.CallPage })));
const SharePage = lazy(() => import("./pages/SharePage.js").then((m) => ({ default: m.SharePage })));
const RecruitersPage = lazy(() => import("./pages/RecruitersPage.js").then((m) => ({ default: m.RecruitersPage })));
const AdminRefsPage = lazy(() => import("./pages/AdminRefsPage.js").then((m) => ({ default: m.AdminRefsPage })));
const AdminGatewayPage = lazy(() => import("./pages/AdminGatewayPage.js").then((m) => ({ default: m.AdminGatewayPage })));

// Phase 7a — account-area pages. Lazy so the Privy SDK chunk isn't pulled
// into the landing/leaderboard bundles.
const AccountPage = lazy(() => import("./pages/AccountPage.js").then((m) => ({ default: m.AccountPage })));
const LoginPage = lazy(() => import("./pages/LoginPage.js").then((m) => ({ default: m.LoginPage })));
// Phase 7b — real agent-creation form + one-time api-key reveal modal.
// Replaces the Phase 7a placeholder that lived at this route.
const AgentNewPage = lazy(() =>
  import("./pages/AgentNewPage.js").then((m) => ({ default: m.AgentNewPage })),
);
// Phase 7c — per-agent settings shell (payout + keys sub-tabs).
const AgentSettingsPage = lazy(() =>
  import("./pages/AgentSettingsPage.js").then((m) => ({
    default: m.AgentSettingsPage,
  })),
);
// Phase 7d — step f of the new-agent flow. Renders the CodeSnippetPanel
// keyed to the agent + reads the freshly-minted secret out of the
// sessionStorage handoff dropped by ApiKeyMintModal.
const IntegratePage = lazy(() =>
  import("./pages/IntegratePage.js").then((m) => ({ default: m.IntegratePage })),
);
// PrivyProvider mounts here, not in main.tsx, so public routes never load
// the Privy SDK. One AccountShell instance wraps every /account/* route so
// auth state survives navigation between login → list → new-agent.
const AccountShell = lazy(() => import("./auth/AccountShell.js").then((m) => ({ default: m.AccountShell })));

/* ── Variant gate ────────────────────────────────────────────────────────
   `?variant=bold|compact|calm` (passed in the hash query, e.g.
   `#/leaderboard?variant=bold`) swaps the default page for a variant
   sibling file. Each variant subagent owns its own .{variant}.tsx files;
   this gate keeps the data flow identical and only swaps the JSX.
   First variant to land owns the convention — be additive, not destructive.
   ──────────────────────────────────────────────────────────────────── */

const LandingPageBold = lazy(() =>
  import("./pages/LandingPage.bold.js").then((m) => ({ default: m.LandingPageBold })),
);
const LeaderboardPageBold = lazy(() =>
  import("./pages/LeaderboardPage.bold.js").then((m) => ({ default: m.LeaderboardPageBold })),
);
const LaunchPageBold = lazy(() =>
  import("./pages/LaunchPage.bold.js").then((m) => ({ default: m.LaunchPageBold })),
);
const MarketDetailPageBold = lazy(() =>
  import("./pages/MarketDetailPage.bold.js").then((m) => ({ default: m.MarketDetailPageBold })),
);
const AgentPageBold = lazy(() =>
  import("./pages/AgentPage.bold.js").then((m) => ({ default: m.AgentPageBold })),
);

const LandingPageCalm = lazy(() =>
  import("./pages/LandingPage.calm.js").then((m) => ({ default: m.VerdictLandingCalm })),
);
const LeaderboardPageCalm = lazy(() =>
  import("./pages/LeaderboardPage.calm.js").then((m) => ({ default: m.LeaderboardPageCalm })),
);
const LaunchPageCalm = lazy(() =>
  import("./pages/LaunchPage.calm.js").then((m) => ({ default: m.LaunchPageCalm })),
);
const MarketDetailPageCalm = lazy(() =>
  import("./pages/MarketDetailPage.calm.js").then((m) => ({ default: m.MarketDetailPageCalm })),
);
const AgentPageCalm = lazy(() =>
  import("./pages/AgentPage.calm.js").then((m) => ({ default: m.AgentPageCalm })),
);

const LandingPageCompact = lazy(() =>
  import("./pages/LandingPage.compact.js").then((m) => ({ default: m.LandingPageCompact })),
);
const LeaderboardPageCompact = lazy(() =>
  import("./pages/LeaderboardPage.compact.js").then((m) => ({ default: m.LeaderboardPageCompact })),
);
const LaunchPageCompact = lazy(() =>
  import("./pages/LaunchPage.compact.js").then((m) => ({ default: m.LaunchPageCompact })),
);
const MarketDetailPageCompact = lazy(() =>
  import("./pages/MarketDetailPage.compact.js").then((m) => ({ default: m.MarketDetailPageCompact })),
);
const AgentPageCompact = lazy(() =>
  import("./pages/AgentPage.compact.js").then((m) => ({ default: m.AgentPageCompact })),
);

type Variant = "bold" | "calm" | "compact" | null;

function parseVariant(hash: string): Variant {
  const raw = (hash || "").replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return null;
  // Use URLSearchParams against everything after the first `?`. Rolls
  // safely when the hash has no query string — no throw on malformed.
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.slice(qIdx + 1));
  } catch {
    return null;
  }
  const v = params.get("variant");
  if (v === "bold") return "bold";
  if (v === "calm") return "calm";
  if (v === "compact") return "compact";
  return null;
}

/**
 * Phase 7a — extract the `?next=` deep-link from the hash query string.
 * Returns the raw (un-decoded) path so LoginPage can sanitize it before
 * navigation. Same defensive parsing posture as parseVariant().
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

interface ParsedRoute {
  name:
    | "landing"
    | "leaderboard"
    | "today"
    | "agent"
    | "agent_calls"
    | "call"
    | "launch"
    | "share"
    | "recruiters"
    | "admin_refs"
    | "admin_gateway"
    | "market"
    | "account"
    | "account_login"
    | "account_agent_new"
    | "account_agent_settings"
    | "account_agent_integrate"
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
  if (path === "/admin/gateway") return { name: "admin_gateway" };
  if (path === "/spec") return { name: "spec" };
  // Phase 7a — account area. `?next=` is parsed below via parseNext()
  // so deep links like #/account/login?next=/account survive sign-in.
  if (path === "/account") return { name: "account" };
  if (path === "/account/login") return { name: "account_login" };
  // Phase 7b — AgentNewPage owns this route: slug/name/bio form +
  // one-time api-key reveal modal. Replaces the Phase 7a placeholder.
  if (path === "/account/agent/new") return { name: "account_agent_new" };
  // Phase 7d — integration / snippet view. Matched BEFORE the settings
  // regex because /payout|/keys is the only tab set we want to fold into
  // settings; /integrate is its own page so the URL is bookmark-stable
  // and analytics can attribute funnel emits cleanly.
  const agentIntegrateMatch = /^\/account\/agent\/([^/]+)\/integrate$/.exec(path);
  if (agentIntegrateMatch) {
    return {
      name: "account_agent_integrate",
      params: { slug: agentIntegrateMatch[1] },
    };
  }
  // Phase 7c — per-agent settings, with /payout (default) and /keys
  // sub-tabs. The trailing tab segment is optional so #/account/agent/foo
  // alone still resolves to the payout tab.
  //
  // Codex P2 fix — bare `/account/agent/new` is caught above by the
  // creation-route check, so we don't need a separate "new" guard here.
  // An agent whose slug happens to be "new" reaches its settings via
  // /account/agent/new/payout or /account/agent/new/keys with no
  // collision against the creation page.
  const agentSettingsMatch = /^\/account\/agent\/([^/]+)(?:\/(payout|keys))?$/.exec(path);
  if (agentSettingsMatch) {
    return {
      name: "account_agent_settings",
      params: {
        slug: agentSettingsMatch[1],
        tab: agentSettingsMatch[2] ?? "payout",
      },
    };
  }
  const shareMatch = /^\/share\/([^/]+)$/.exec(path);
  if (shareMatch) return { name: "share", params: { slug: shareMatch[1] } };
  const marketMatch = /^\/markets\/(.+)$/.exec(path);
  if (marketMatch) {
    // Codex audit: decodeURIComponent throws on malformed percent
    // sequences (e.g. "%E0%A4%A"). Fall through to landing instead of
    // crashing the whole route resolver.
    let market_id: string;
    try {
      market_id = decodeURIComponent(marketMatch[1]);
    } catch {
      return { name: "landing" };
    }
    return { name: "market", params: { market_id } };
  }
  const callMatch = /^\/calls\/(.+)$/.exec(path);
  if (callMatch) return { name: "call", params: { call_id: callMatch[1] } };
  // Wave 1 — /agents/:slug/claim route deleted alongside ClaimPage.
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
  const variant = parseVariant(hash);
  const next = parseNext(hash);

  return (
    <Suspense fallback={<div className="min-h-dvh bg-[var(--color-bg)]" />}>
      {route.name === "landing" &&
        (variant === "bold" ? (
          <LandingPageBold />
        ) : variant === "calm" ? (
          <LandingPageCalm />
        ) : (
          <LandingPageCompact />
        ))}
      {route.name === "leaderboard" &&
        (variant === "bold" ? (
          <LeaderboardPageBold />
        ) : variant === "calm" ? (
          <LeaderboardPageCalm />
        ) : (
          <LeaderboardPageCompact />
        ))}
      {route.name === "today" && <TodayPage />}
      {route.name === "agent" &&
        (variant === "bold" ? (
          <AgentPageBold slug={route.params!.slug} />
        ) : variant === "calm" ? (
          <AgentPageCalm slug={route.params!.slug} />
        ) : (
          <AgentPageCompact slug={route.params!.slug} />
        ))}
      {route.name === "agent_calls" &&
        (variant === "bold" ? (
          <AgentPageBold slug={route.params!.slug} />
        ) : variant === "calm" ? (
          <AgentPageCalm slug={route.params!.slug} />
        ) : (
          <AgentPageCompact slug={route.params!.slug} />
        ))}
      {route.name === "call" && <CallPage callId={route.params!.call_id} />}
      {route.name === "launch" &&
        (variant === "bold" ? (
          <LaunchPageBold />
        ) : variant === "calm" ? (
          <LaunchPageCalm />
        ) : (
          <LaunchPageCompact />
        ))}
      {route.name === "share" && <SharePage slug={route.params!.slug} />}
      {route.name === "recruiters" && <RecruitersPage />}
      {route.name === "admin_refs" && <AdminRefsPage />}
      {route.name === "admin_gateway" && <AdminGatewayPage />}
      {route.name === "market" &&
        (variant === "bold" ? (
          <MarketDetailPageBold marketId={route.params!.market_id} />
        ) : variant === "calm" ? (
          <MarketDetailPageCalm marketId={route.params!.market_id} />
        ) : (
          <MarketDetailPageCompact marketId={route.params!.market_id} />
        ))}
      {(route.name === "account" ||
        route.name === "account_login" ||
        route.name === "account_agent_new" ||
        route.name === "account_agent_settings" ||
        route.name === "account_agent_integrate") && (
        <AccountShell>
          {route.name === "account" && <AccountPage />}
          {route.name === "account_login" && <LoginPage next={decodeNext(next)} />}
          {route.name === "account_agent_new" && <AgentNewPage />}
          {route.name === "account_agent_settings" && (
            <AgentSettingsPage
              slug={route.params!.slug}
              tab={(route.params!.tab as "payout" | "keys") ?? "payout"}
            />
          )}
          {route.name === "account_agent_integrate" && (
            <IntegratePage slug={route.params!.slug} />
          )}
        </AccountShell>
      )}
      {route.name === "spec" && <SpecPage />}
    </Suspense>
  );
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
