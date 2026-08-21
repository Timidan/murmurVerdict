import { useEffect, useState } from "react";
import {
  verdictApi,
  type ControllerIdentitySnapshot,
  type FeedSlaAdminResponse,
  type FhenixLifecycleSnapshot,
  type GatewayOperatorSnapshot,
  type LiveCanarySnapshot,
  type OperatorAlertsSnapshot,
} from "../api.js";
import { readAdminToken, writeAdminToken, clearAdminToken } from "../admin-session.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { InlineError } from "../components/compact/InlineError.js";
import { LogoLoader } from "../components/LogoLoader.js";

/**
 * /admin/overview — the operator health cockpit. One tier above the
 * /admin/gateway relayer control plane: it loads the same six admin
 * observability snapshots (gateway, reveal lifecycle, canaries, operator
 * alerts, controller identity, feed SLA) and renders compact health cards
 * with an overall status banner, linking into #/admin/gateway for the deep
 * per-attempt tables. Token-gated like the gateway page and sharing the same
 * admin-token storage key, so a token entered on either page carries over.
 * That storage key + read/write/clear now live in the shared admin-session
 * module, so this page never touches localStorage directly.
 */

type Health = "nominal" | "warn" | "attention" | "unknown";

export function AdminOverviewPage() {
  const [token, setToken] = useState<string>(() => readAdminToken());
  const [tokenInput, setTokenInput] = useState("");
  const [gateway, setGateway] = useState<GatewayOperatorSnapshot | null>(null);
  const [lifecycle, setLifecycle] = useState<FhenixLifecycleSnapshot | null>(null);
  const [canaries, setCanaries] = useState<LiveCanarySnapshot | null>(null);
  const [alerts, setAlerts] = useState<OperatorAlertsSnapshot | null>(null);
  const [identity, setIdentity] = useState<ControllerIdentitySnapshot | null>(null);
  const [feedSla, setFeedSla] = useState<FeedSlaAdminResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "checks" | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async (nextToken = token) => {
    if (!nextToken) return;
    setBusy((prev) => prev ?? "load");
    setError(null);
    try {
      const [g, lc, cn, al, id, sla] = await Promise.all([
        verdictApi.adminGateway(nextToken, { limit: 1 }),
        verdictApi.adminFhenixLifecycle(nextToken, { limit: 1 }),
        verdictApi.adminCanaries(nextToken),
        verdictApi.adminOperatorAlerts(nextToken, { status: "open", limit: 1 }),
        verdictApi.adminIdentityControllers(nextToken, { limit: 1 }),
        verdictApi.adminFeedSla(nextToken, { status: "open", limit: 1 }),
      ]);
      setGateway(g);
      setLifecycle(lc);
      setCanaries(cn);
      setAlerts(al);
      setIdentity(id);
      setFeedSla(sla);
      setLoaded(true);
    } catch (e) {
      setError(
        `the overview did not load. retry, or check the daemon. (${(e as Error).message})`,
      );
    } finally {
      setBusy((prev) => (prev === "load" ? null : prev));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const submitToken = () => {
    if (!tokenInput) return;
    writeAdminToken(tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

  const signOut = () => {
    clearAdminToken();
    setToken("");
    setGateway(null);
    setLifecycle(null);
    setCanaries(null);
    setAlerts(null);
    setIdentity(null);
    setFeedSla(null);
    setLoaded(false);
  };

  // The canaries GET returns the cached snapshot (often the not-yet-checked
  // placeholder) and alert delivery only runs on tick, so "run live checks"
  // probes both and refreshes the rest.
  const runChecks = async () => {
    if (!token) return;
    setBusy("checks");
    setError(null);
    try {
      const [cn, alertTick] = await Promise.all([
        verdictApi.adminCanariesTick(token),
        verdictApi.adminOperatorAlertsTick(token),
      ]);
      setCanaries(cn);
      setAlerts(alertTick.snapshot);
      await load(token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!token) {
    return (
      <TokenPrompt
        value={tokenInput}
        onChange={setTokenInput}
        onSubmit={submitToken}
        error={error}
      />
    );
  }

  const cards = loaded
    ? [
        gatewayCard(gateway),
        lifecycleCard(lifecycle),
        canaryCard(canaries),
        alertsCard(alerts),
        identityCard(identity),
        feedSlaCard(feedSla),
      ]
    : [];
  const overall = overallHealth(cards.map((c) => c.health));

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            admin <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">overview</span>
          </span></TopbarCrumb>

      {/* CONTROL STRIP ───────────────────────────────── */}
      <section className="border-b border-[var(--color-border)] px-3 py-2 flex items-center justify-between flex-wrap gap-2">
        <span className="ck-title">operator health</span>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            className="ck-btn ck-btn-bracket"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            {busy === "load" ? "loading" : "refresh"}
          </button>
          <button
            className="ck-btn ck-btn-bracket ck-pos"
            onClick={runChecks}
            disabled={busy !== null}
          >
            {busy === "checks" ? "running" : "run live checks"}
          </button>
          <a href="#/admin/gateway" className="ck-btn ck-btn-bracket">
            gateway →
          </a>
          <button className="ck-btn ck-btn-bracket" onClick={signOut}>
            sign out
          </button>
        </div>
      </section>

      <main className="flex-1 min-h-0 flex flex-col">
        {error && (
          <InlineError
            error={error}
            className="border-b border-[var(--color-border)] px-3 py-2 ck-mono"
          />
        )}

        {!loaded && !error && (
          <div className="px-3 py-8 flex justify-center"><LogoLoader width={300} /></div>
        )}

        {loaded && <StatusBanner health={overall} cards={cards} />}

        {loaded && (
          <Panel title="health cards" meta={`${cards.length}`}>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-[var(--color-border)]">
              {cards.map((card) => (
                <HealthCard key={card.title} card={card} />
              ))}
            </div>
          </Panel>
        )}
      </main>
    </div>
  );
}

// ---- card model -----------------------------------------------------------

interface CardStat {
  label: string;
  value: number | string;
  tone?: "pos" | "neg" | "dim";
}

interface OverviewCard {
  title: string;
  health: Health;
  status: string;
  stats: CardStat[];
  href?: string;
}

function gatewayCard(s: GatewayOperatorSnapshot | null): OverviewCard {
  if (!s) return unknownCard("relayer gateway");
  if (!s.configured) {
    return {
      title: "relayer gateway",
      health: "warn",
      status: "not configured",
      stats: [{ label: "chain", value: "—", tone: "dim" }],
      href: "#/admin/gateway",
    };
  }
  const stuck = s.queues.stuck + s.feed_queues.stuck;
  const failed =
    (s.status_counts.failed_terminal ?? 0) + (s.feed_status_counts.failed_terminal ?? 0);
  const rpcErrors = s.telemetry.rpc_errors + s.feed_telemetry.rpc_errors;
  const due = s.queues.due_for_broadcast + s.feed_queues.due_for_broadcast;
  const health: Health = stuck > 0 || failed > 0 ? "attention" : rpcErrors > 0 ? "warn" : "nominal";
  return {
    title: "relayer gateway",
    health,
    status: stuck > 0 ? `${stuck} stuck` : failed > 0 ? `${failed} terminal` : "relaying",
    stats: [
      { label: "due", value: due, tone: "dim" },
      { label: "stuck", value: stuck, tone: stuck > 0 ? "neg" : "dim" },
      { label: "terminal", value: failed, tone: failed > 0 ? "neg" : "dim" },
      { label: "rpc errs", value: rpcErrors, tone: rpcErrors > 0 ? "neg" : "dim" },
    ],
    href: "#/admin/gateway",
  };
}

function lifecycleCard(s: FhenixLifecycleSnapshot | null): OverviewCard {
  if (!s) return unknownCard("reveal lifecycle");
  const overdue = s.queues.overdue_grace;
  const attention = s.queues.needs_attention;
  const bad = s.counts.invalid + s.counts.missed;
  const health: Health =
    overdue > 0 || bad > 0 ? "attention" : attention > 0 ? "warn" : "nominal";
  return {
    title: "reveal lifecycle",
    health,
    status: overdue > 0 ? `${overdue} overdue` : bad > 0 ? `${bad} failed` : "on schedule",
    stats: [
      { label: "pending", value: s.counts.pending, tone: "dim" },
      { label: "revealed", value: s.counts.revealed, tone: "pos" },
      { label: "invalid", value: s.counts.invalid, tone: s.counts.invalid > 0 ? "neg" : "dim" },
      { label: "missed", value: s.counts.missed, tone: s.counts.missed > 0 ? "neg" : "dim" },
    ],
    href: "#/admin/gateway",
  };
}

function canaryCard(s: LiveCanarySnapshot | null): OverviewCard {
  if (!s) return unknownCard("live canaries");
  const checks = s.checks ?? [];
  const ok = checks.filter((c) => c.status === "ok").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const disabled = checks.filter((c) => c.status === "disabled").length;
  const ran = ok + fail > 0;
  const health: Health = fail > 0 ? "attention" : ran ? "nominal" : "unknown";
  return {
    title: "live canaries",
    health,
    status: fail > 0 ? `${fail} failing` : ran ? "all green" : "not yet checked",
    stats: [
      { label: "ok", value: ok, tone: ok > 0 ? "pos" : "dim" },
      { label: "fail", value: fail, tone: fail > 0 ? "neg" : "dim" },
      { label: "disabled", value: disabled, tone: "dim" },
    ],
  };
}

function alertsCard(s: OperatorAlertsSnapshot | null): OverviewCard {
  if (!s) return unknownCard("operator alerts");
  const open = s.counts.open;
  const health: Health =
    open.critical > 0 ? "attention" : open.warning > 0 ? "warn" : "nominal";
  return {
    title: "operator alerts",
    health,
    status:
      open.critical > 0
        ? `${open.critical} critical`
        : open.warning > 0
          ? `${open.warning} warning`
          : "no open alerts",
    stats: [
      { label: "open", value: open.total, tone: open.total > 0 ? "neg" : "dim" },
      { label: "critical", value: open.critical, tone: open.critical > 0 ? "neg" : "dim" },
      { label: "warning", value: open.warning, tone: open.warning > 0 ? "neg" : "dim" },
      { label: "sink", value: s.sink_configured ? "set" : "local", tone: "dim" },
    ],
  };
}

function identityCard(s: ControllerIdentitySnapshot | null): OverviewCard {
  if (!s) return unknownCard("controller wallets");
  const health: Health =
    s.counts.overdue > 0 ? "attention" : s.counts.due_soon > 0 ? "warn" : "nominal";
  return {
    title: "controller wallets",
    health,
    status: s.counts.overdue > 0
      ? `${s.counts.overdue} overdue`
      : s.counts.due_soon > 0
        ? `${s.counts.due_soon} due soon`
        : "attested",
    stats: [
      { label: "bound", value: s.counts.controller_wallets, tone: "dim" },
      { label: "active keys", value: s.counts.active_runtime_keys, tone: "dim" },
      { label: "due soon", value: s.counts.due_soon, tone: s.counts.due_soon > 0 ? "neg" : "dim" },
      { label: "overdue", value: s.counts.overdue, tone: s.counts.overdue > 0 ? "neg" : "dim" },
    ],
  };
}

function feedSlaCard(s: FeedSlaAdminResponse | null): OverviewCard {
  if (!s) return unknownCard("feed SLA");
  const sum = s.summary;
  const recs = sum.refund_recommendations + sum.slash_recommendations;
  const health: Health =
    sum.open_incidents > 0 || recs > 0
      ? "attention"
      : sum.degraded_feeds > 0
        ? "warn"
        : "nominal";
  return {
    title: "feed SLA",
    health,
    status: sum.open_incidents > 0 ? `${sum.open_incidents} ${sum.open_incidents === 1 ? "incident" : "incidents"}` : "all on time",
    stats: [
      { label: "open", value: sum.open_incidents, tone: sum.open_incidents > 0 ? "neg" : "dim" },
      { label: "refund recs", value: sum.refund_recommendations, tone: sum.refund_recommendations > 0 ? "neg" : "dim" },
      { label: "slash recs", value: sum.slash_recommendations, tone: sum.slash_recommendations > 0 ? "neg" : "dim" },
      { label: "degraded", value: sum.degraded_feeds, tone: sum.degraded_feeds > 0 ? "neg" : "dim" },
    ],
    href: "#/admin/gateway",
  };
}

function unknownCard(title: string): OverviewCard {
  return { title, health: "unknown", status: "no data", stats: [] };
}

function overallHealth(parts: Health[]): Health {
  if (parts.includes("attention")) return "attention";
  if (parts.includes("warn")) return "warn";
  if (parts.length > 0 && parts.every((p) => p === "nominal")) return "nominal";
  return "unknown";
}

// ---- presentational -------------------------------------------------------

function StatusBanner({ health, cards }: { health: Health; cards: OverviewCard[] }) {
  const attention = cards.filter((c) => c.health === "attention");
  const warn = cards.filter((c) => c.health === "warn");
  const label =
    health === "attention"
      ? "needs attention"
      : health === "warn"
        ? "degraded"
        : health === "nominal"
          ? "all systems nominal"
          : "status unknown";
  const detail =
    attention.length > 0
      ? attention.map((c) => `${c.title}: ${c.status}`).join("  ·  ")
      : warn.length > 0
        ? warn.map((c) => `${c.title}: ${c.status}`).join("  ·  ")
        : "gateway, reveals, canaries, alerts, wallets, and feeds are healthy.";
  return (
    <div className="border-b border-[var(--color-border)] px-3 py-2 flex items-center gap-3 flex-wrap">
      <HealthDot health={health} />
      <span className={`ck-label ${healthTextClass(health)}`}>{label}</span>
      <span className="ck-mono ck-dim">{detail}</span>
    </div>
  );
}

function HealthCard({ card }: { card: OverviewCard }) {
  const body = (
    <div className="bg-[var(--color-bg)] px-4 py-3 h-full flex flex-col gap-3 transition-colors duration-[var(--dur-fast)] ease-out hover:bg-[var(--color-surface)]">
      <div className="flex items-center justify-between gap-3">
        <span className="ck-title">{card.title}</span>
        <HealthDot health={card.health} />
      </div>
      <div className={`ck-mono text-2xl tabular-nums ${healthTextClass(card.health)}`}>{card.status}</div>
      {card.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-auto pt-2">
          {card.stats.map((s) => (
            <div key={s.label} className="flex items-baseline justify-between gap-2">
              <span className="ck-label">{s.label}</span>
              <span className={`ck-mono tabular-nums ${statToneClass(s.tone)}`}>{s.value}</span>
            </div>
          ))}
        </div>
      )}
      {card.href && (
        <span className="ck-mono ck-dim mt-1">details →</span>
      )}
    </div>
  );
  if (!card.href) return body;
  return (
    <a href={card.href} className="block">
      {body}
    </a>
  );
}

function HealthDot({ health }: { health: Health }) {
  const cls =
    health === "nominal"
      ? "bg-[var(--color-display)]"
      : health === "warn"
        ? "bg-[var(--color-secondary)]"
        : health === "attention"
          ? "bg-[var(--color-accent)]"
          : "bg-[var(--color-disabled)]";
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} aria-hidden />;
}

function healthTextClass(health: Health): string {
  if (health === "attention") return "ck-neg";
  if (health === "warn") return "ck-dim";
  if (health === "nominal") return "ck-pos";
  return "ck-dim";
}

function statToneClass(tone: CardStat["tone"]): string {
  if (tone === "neg") return "ck-neg";
  if (tone === "pos") return "ck-pos";
  return "ck-dim";
}

function TokenPrompt({
  value,
  onChange,
  onSubmit,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  error: string | null;
}) {
  useEffect(() => {
    const hash = window.location.hash || "";
    const idx = hash.indexOf("?");
    if (idx < 0) return;
    const token = new URLSearchParams(hash.slice(idx + 1)).get("token");
    if (token && !value) onChange(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            admin <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">overview</span>
          </span></TopbarCrumb>
      <main className="flex-1 flex items-center justify-center px-4">
        <section className="ck-frame w-full max-w-[480px]">
          <div className="ck-header">
            <span className="ck-label ck-pos">admin token</span>
            <span className="ck-mono ck-dim">admin</span>
          </div>
          <div className="px-4 py-6 flex flex-col gap-4">
            {error && (
              <InlineError
                error={error}
                className="ck-frame-strong px-3 py-2 ck-mono"
              />
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
              className="flex flex-col gap-4"
            >
              <label htmlFor="admin-overview-token" className="ck-label">admin token</label>
              <input
                id="admin-overview-token"
                type="password"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="border bg-[var(--color-bg)] border-[var(--color-border-vis)] px-3 py-2 ck-mono text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
                placeholder="VERDICT_ADMIN_TOKEN"
                autoFocus
              />
              <button type="submit" className="ck-btn ck-btn-bracket ck-pos justify-center py-2">
                unlock
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}
