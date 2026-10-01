import { useEffect, useState } from "react";
import {
  verdictApi,
  type ControllerIdentityRow,
  type ControllerIdentitySnapshot,
  type FeedAvailabilitySummary,
  type FeedSlaAdminResponse,
  type FeedSlaIncident,
  type GatewayAttemptStatus,
  type GatewayOperatorAttempt,
  type GatewayOperatorFeedAttempt,
  type GatewayOperatorSnapshot,
  type FhenixLifecycleRow,
  type FhenixLifecycleSnapshot,
  type LiveCanaryCheck,
  type LiveCanarySnapshot,
  type OperatorAlert,
  type OperatorAlertsSnapshot,
} from "../api.js";
import { readAdminToken, writeAdminToken, clearAdminToken } from "../admin-session.js";
import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { InlineError } from "../components/compact/InlineError.js";
import { formatScore } from "../lib/score-format.js";
import { formatLocalDateTimeShort } from "../lib/date-time-format.js";
import { LogoLoader } from "../components/LogoLoader.js";
import { sentenceCase } from "../lib/display-format.js";

const STATUSES: GatewayAttemptStatus[] = [
  "queued",
  "submitted",
  "confirmed",
  "accepted",
  "failed_retryable",
  "failed_terminal",
];

export function AdminGatewayPage() {
  const [token, setToken] = useState<string>(() => readAdminToken());
  const [tokenInput, setTokenInput] = useState("");
  const [status, setStatus] = useState<GatewayAttemptStatus | "all">("all");
  const [snapshot, setSnapshot] = useState<GatewayOperatorSnapshot | null>(null);
  const [feedSla, setFeedSla] = useState<FeedSlaAdminResponse | null>(null);
  const [canaries, setCanaries] = useState<LiveCanarySnapshot | null>(null);
  const [lifecycle, setLifecycle] = useState<FhenixLifecycleSnapshot | null>(null);
  const [identity, setIdentity] = useState<ControllerIdentitySnapshot | null>(null);
  const [alerts, setAlerts] = useState<OperatorAlertsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "tick" | string | null>(null);

  const load = async (nextToken = token) => {
    if (!nextToken) return;
    setBusy((prev) => prev ?? "load");
    setError(null);
    try {
      const [gateway, sla, liveCanaries, fhenixLifecycle, identitySnapshot, operatorAlerts] = await Promise.all([
        verdictApi.adminGateway(nextToken, {
          status: status === "all" ? undefined : status,
          limit: 80,
        }),
        verdictApi.adminFeedSla(nextToken, { status: "open", limit: 80 }),
        verdictApi.adminCanaries(nextToken),
        verdictApi.adminFhenixLifecycle(nextToken, { limit: 80 }),
        verdictApi.adminIdentityControllers(nextToken, { limit: 80 }),
        verdictApi.adminOperatorAlerts(nextToken, { status: "open", limit: 80 }),
      ]);
      setSnapshot(gateway);
      setFeedSla(sla);
      setCanaries(liveCanaries);
      setLifecycle(fhenixLifecycle);
      setIdentity(identitySnapshot);
      setAlerts(operatorAlerts);
    } catch (e) {
      setError(
        `the gateway snapshot did not load. retry, or check the daemon. (${(e as Error).message})`,
      );
    } finally {
      setBusy((prev) => (prev === "load" ? null : prev));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status]);

  const submitToken = () => {
    if (!tokenInput) return;
    writeAdminToken(tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

  const signOut = () => {
    clearAdminToken();
    setToken("");
    setSnapshot(null);
    setFeedSla(null);
    setCanaries(null);
    setLifecycle(null);
    setIdentity(null);
    setAlerts(null);
  };

  const runTick = async () => {
    if (!token) return;
    setBusy("tick");
    setError(null);
    try {
      await verdictApi.adminGatewayTick(token);
      // Reload via load(): the tick's own snapshot ignores the status filter.
      await load(token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const retry = async (attemptId: string) => {
    if (!token) return;
    setBusy(attemptId);
    setError(null);
    try {
      await verdictApi.adminGatewayRetry(token, attemptId);
      await load(token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runSlaTick = async () => {
    if (!token) return;
    setBusy("sla");
    setError(null);
    try {
      await verdictApi.adminFeedSlaTick(token);
      await load(token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runCanaryTick = async () => {
    if (!token) return;
    setBusy("canaries");
    setError(null);
    try {
      const data = await verdictApi.adminCanariesTick(token);
      setCanaries(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runAlertTick = async () => {
    if (!token) return;
    setBusy("alerts");
    setError(null);
    try {
      const data = await verdictApi.adminOperatorAlertsTick(token);
      setAlerts(data.snapshot);
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

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb><span>
            admin <span className="ck-dim mx-1">/</span>
            <span className="ck-pos">gateway</span>
          </span></TopbarCrumb>

      {/* CONTROL STRIP ─────────────────────────────────── */}
      <section className="border-b border-[var(--color-border)] px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
        <span className="ck-title">Relayer control plane</span>
        <div className="flex items-center gap-3 flex-wrap">
          <a href="#/admin/overview" className="ck-btn ck-btn-bracket no-underline">← overview</a>
          <button
            className="ck-btn ck-btn-bracket"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            refresh
          </button>
          <button
            className="ck-btn ck-btn-bracket ck-pos"
            onClick={runTick}
            disabled={busy !== null || !snapshot?.configured}
          >
            {busy === "tick" ? "running" : "run tick"}
          </button>
          <button className="ck-btn ck-btn-bracket" onClick={signOut}>sign out</button>
        </div>
      </section>

      <main className="flex-1 min-h-0 overflow-auto ck-scroll flex flex-col">
        {error && (
          <InlineError
            error={error}
            className="border-b border-[var(--color-border)] px-3 py-2 ck-mono"
          />
        )}

        {!snapshot && !error && (
          <div className="px-3 py-8 flex justify-center"><LogoLoader width={300} /></div>
        )}

        {snapshot && (
          <div className="flex flex-col gap-3 p-3">
            <GatewaySummary snapshot={snapshot} />

            <OperatorAlertsPanel snapshot={alerts} busy={busy} onRunTick={runAlertTick} />

            <CanaryPanel snapshot={canaries} busy={busy} onRunTick={runCanaryTick} />

            <RevealLifecyclePanel snapshot={lifecycle} />

            <IdentityPanel snapshot={identity} />

            <FeedSlaPanel response={feedSla} busy={busy} onRunTick={runSlaTick} />

            <Panel
              title="Attempts"
              meta={`${snapshot.recent_attempts.length}`}
              actions={
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as GatewayAttemptStatus | "all")}
                  className="ck-mono ck-select"
                >
                  <option value="all">all</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              }
            >
              <AttemptTable
                rows={snapshot.recent_attempts}
                busy={busy}
                onRetry={retry}
              />
            </Panel>

            <Panel title="Feed attempts" meta={`${snapshot.feed_recent_attempts.length}`}>
              <FeedAttemptTable
                rows={snapshot.feed_recent_attempts}
                busy={busy}
                onRetry={retry}
              />
            </Panel>

            <Panel title="Stuck" meta={`${snapshot.stuck_attempts.length}`}>
              <AttemptTable
                rows={snapshot.stuck_attempts}
                busy={busy}
                onRetry={retry}
                empty="No stuck submitted or confirmed attempts"
              />
            </Panel>

            <Panel title="Stuck feeds" meta={`${snapshot.feed_stuck_attempts.length}`}>
              <FeedAttemptTable
                rows={snapshot.feed_stuck_attempts}
                busy={busy}
                onRetry={retry}
                empty="No stuck submitted or confirmed feed attempts"
              />
            </Panel>
          </div>
        )}
      </main>
    </div>
  );
}

function OperatorAlertsPanel({
  snapshot,
  busy,
  onRunTick,
}: {
  snapshot: OperatorAlertsSnapshot | null;
  busy: string | null;
  onRunTick: () => void;
}) {
  const rows = snapshot?.alerts ?? [];
  const counts = snapshot?.counts.open;
  return (
    <Panel
      title="Operator alerts"
      meta={`sink ${snapshot?.sink_configured ? "configured" : "local only"}`}
      actions={
        <button className="ck-btn ck-btn-bracket" onClick={onRunTick} disabled={busy !== null}>
          {busy === "alerts" ? "running" : "run alerts"}
        </button>
      }
    >
      <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="open" value={counts?.total ?? 0} tone={(counts?.total ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="critical" value={counts?.critical ?? 0} tone={(counts?.critical ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="warning" value={counts?.warning ?? 0} tone={(counts?.warning ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="info" value={counts?.info ?? 0} tone="dim" />
      </div>
      <OperatorAlertTable rows={rows} />
    </Panel>
  );
}

function OperatorAlertTable({ rows }: { rows: OperatorAlert[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        No open operator alerts
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1199px]">
        <div className="grid grid-cols-[110px_209px_170px_1fr_150px_200px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Severity</span>
          <span>Source</span>
          <span>Kind</span>
          <span>Alert</span>
          <span>Delivery</span>
          <span className="text-right">Seen</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.alert_id}
              className={
                "grid grid-cols-[110px_209px_170px_1fr_150px_200px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`ck-mono ${alertSeverityClass(row.severity)}`}>{row.severity}</span>
              <span className="ck-mono ck-dim">{row.source}</span>
              <span className="ck-mono ck-dim truncate">{row.kind}</span>
              <span>
                <span className="block ck-mono ck-pos">{row.title}</span>
                <span className="block ck-mono ck-dim truncate">{row.description}</span>
              </span>
              <span
                className="ck-mono ck-dim truncate"
                title={`${row.delivery_status} · ${row.delivery_attempts}`}
              >
                {row.delivery_status} · {row.delivery_attempts}
              </span>
              <span className="ck-mono text-right ck-dim">{shortDate(row.last_seen_at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FeedSlaPanel({
  response,
  busy,
  onRunTick,
}: {
  response: FeedSlaAdminResponse | null;
  busy: string | null;
  onRunTick: () => void;
}) {
  const rows = response?.incidents ?? [];
  const summary = response?.summary;
  const health = response?.feed_health ?? [];
  return (
    <Panel
      title="Feed SLA incidents"
      actions={
        <button className="ck-btn ck-btn-bracket" onClick={onRunTick} disabled={busy !== null}>
          {busy === "sla" ? "running" : "run sla tick"}
        </button>
      }
    >
      <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="open missed" value={summary?.open_incidents ?? rows.length} tone={(summary?.open_incidents ?? rows.length) > 0 ? "neg" : "dim"} />
        <Stat label="refund recs" value={summary?.refund_recommendations ?? 0} tone={(summary?.refund_recommendations ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="slash recs" value={summary?.slash_recommendations ?? 0} tone={(summary?.slash_recommendations ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="pay exec" value={summary?.payment_execution_enabled ? "on" : "off"} tone="dim" />
      </div>
      <FeedHealthTable rows={health} />
      <FeedSlaTable rows={rows} />
    </Panel>
  );
}

function FeedHealthTable({ rows }: { rows: FeedAvailabilitySummary[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 ck-mono ck-dim border-b border-[var(--color-border)]">
        No listed cadence feeds
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-b border-[var(--color-border)]">
      <div className="min-w-[1100px]">
        <div className="grid grid-cols-[1fr_120px_110px_120px_130px_200px_130px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Feed</span>
          <span>Health</span>
          <span className="text-right">Rel</span>
          <span className="text-right">Missed</span>
          <span className="text-right">Next seq</span>
          <span>Next deadline</span>
          <span className="text-right">Proof</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.feed_id}
              className={
                "grid grid-cols-[1fr_120px_110px_120px_130px_200px_130px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="ck-mono ck-pos truncate">{row.feed_id}</span>
              <span className={`ck-mono ${feedHealthClass(row.health_status)}`}>{row.overdue ? "overdue" : row.health_status}</span>
              <span className="ck-mono text-right">{formatPercent(row.reliability_score)}</span>
              <span className="ck-mono text-right">{row.open_missed_packets}/{row.missed_packets}</span>
              <span className="ck-mono text-right">{row.next_expected_sequence ?? "—"}</span>
              <span className="ck-mono ck-dim">{row.next_deadline_at ? shortDate(row.next_deadline_at) : "—"}</span>
              <span className="ck-mono text-right ck-dim">{row.proof_hash.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function IdentityPanel({ snapshot }: { snapshot: ControllerIdentitySnapshot | null }) {
  const rows = snapshot?.needs_attention ?? [];
  return (
    <Panel
      title="Controller wallets"
      meta={`due by ${snapshot ? shortDate(snapshot.due_soon_at) : "—"}`}
    >
      <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="bound" value={snapshot?.counts.controller_wallets ?? 0} tone="dim" />
        <Stat label="active keys" value={snapshot?.counts.active_runtime_keys ?? 0} tone="dim" />
        <Stat label="due soon" value={snapshot?.counts.due_soon ?? 0} tone={(snapshot?.counts.due_soon ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="overdue" value={snapshot?.counts.overdue ?? 0} tone={(snapshot?.counts.overdue ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="attention" value={snapshot?.counts.needs_attention ?? 0} tone={(snapshot?.counts.needs_attention ?? 0) > 0 ? "neg" : "dim"} />
      </div>
      <IdentityTable rows={rows} />
    </Panel>
  );
}

function IdentityTable({ rows }: { rows: ControllerIdentityRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        No controller wallets need re-attestation
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1154px]">
        <div className="grid grid-cols-[147px_130px_1fr_147px_200px_90px_90px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Status</span>
          <span>Agent</span>
          <span>Wallet</span>
          <span>Kind</span>
          <span className="text-right">Due</span>
          <span className="text-right">Keys</span>
          <span className="text-right">Revoked</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.agent_id}
              className={
                "grid grid-cols-[147px_130px_1fr_147px_200px_90px_90px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`ck-mono ${identityStatusClass(row.status)}`}>{row.status}</span>
              <span className="ck-mono ck-pos truncate">{row.agent_slug ?? row.agent_id.slice(0, 8)}</span>
              <span className="ck-mono ck-dim truncate">{shortHex(row.wallet_address)}</span>
              <span
                className="ck-mono ck-dim truncate"
                title={`${row.wallet_kind}${row.provider ? `/${row.provider}` : ""}`}
              >
                {row.wallet_kind}{row.provider ? `/${row.provider}` : ""}
              </span>
              <span className="ck-mono text-right ck-dim">{row.reattestation_due_at ? shortDate(row.reattestation_due_at) : "—"}</span>
              <span className="ck-mono text-right">{row.active_runtime_keys}/{row.total_runtime_keys}</span>
              <span className="ck-mono text-right">{row.revoked_runtime_keys}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CanaryPanel({
  snapshot,
  busy,
  onRunTick,
}: {
  snapshot: LiveCanarySnapshot | null;
  busy: string | null;
  onRunTick: () => void;
}) {
  const rows = snapshot?.checks ?? [];
  const ok = rows.filter((row) => row.status === "ok").length;
  const failing = rows.filter((row) => row.status === "fail").length;
  const disabled = rows.filter((row) => row.status === "disabled").length;
  return (
    <Panel
      title="Live canaries"
      actions={
        <button className="ck-btn ck-btn-bracket" onClick={onRunTick} disabled={busy !== null}>
          {busy === "canaries" ? "running" : "run canaries"}
        </button>
      }
    >
      <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="total" value={rows.length} tone={snapshot?.ok ? "pos" : "neg"} />
        <Stat label="ok" value={ok} tone={ok > 0 ? "pos" : "dim"} />
        <Stat label="fail" value={failing} tone={failing > 0 ? "neg" : "dim"} />
        <Stat label="disabled" value={disabled} tone="dim" />
      </div>
      <CanaryTable rows={rows} />
    </Panel>
  );
}

function RevealLifecyclePanel({ snapshot }: { snapshot: FhenixLifecycleSnapshot | null }) {
  const counts = snapshot?.counts;
  const attention = snapshot?.needs_attention ?? [];
  const cursors = snapshot?.cursors ?? [];
  return (
    <Panel
      title="Reveal lifecycle"
      meta={`grace ${snapshot?.configured.reveal_grace_seconds ?? "—"}s`}
    >
      <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="pending" value={counts?.pending ?? 0} tone={(counts?.pending ?? 0) > 0 ? "dim" : "pos"} />
        <Stat label="revealed" value={counts?.revealed ?? 0} tone="pos" />
        <Stat label="invalid" value={counts?.invalid ?? 0} tone={(counts?.invalid ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="missed" value={counts?.missed ?? 0} tone={(counts?.missed ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="attention" value={snapshot?.queues.needs_attention ?? 0} tone={(snapshot?.queues.needs_attention ?? 0) > 0 ? "neg" : "dim"} />
      </div>
      <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
        <Fact label="verifier" value={snapshot?.configured.verifier ? "yes" : "no"} />
        <Fact label="watcher" value={snapshot?.configured.watcher ? "yes" : "no"} />
        <Fact label="overdue" value={snapshot?.queues.overdue_grace ?? 0} />
        <Fact label="cursor" value={formatCursor(cursors)} />
      </div>
      <RevealLifecycleTable rows={attention} />
    </Panel>
  );
}

function RevealLifecycleTable({ rows }: { rows: FhenixLifecycleRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        No reveal lifecycle rows need attention
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1346px]">
        <div className="grid grid-cols-[110px_120px_1fr_200px_110px_188px_1fr_178px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Status</span>
          <span>Agent</span>
          <span>Market</span>
          <span>Reveal open</span>
          <span className="text-right">Block</span>
          <span>Resolution</span>
          <span>Reason</span>
          <span className="text-right">Call</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.call_id}
              className={
                "grid grid-cols-[110px_120px_1fr_200px_110px_188px_1fr_178px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`ck-mono ${revealStatusClass(row.reveal_status, row.overdue_grace)}`}>
                {row.overdue_grace ? "overdue" : row.reveal_status}
              </span>
              {/* title carries the full id; the cell shortens slug-less rows. */}
              <span
                className="ck-mono ck-dim truncate"
                title={row.agent_slug ?? row.agent_id}
              >
                {row.agent_slug ?? row.agent_id.slice(0, 8)}
              </span>
              <span className="ck-mono ck-pos truncate">{row.market_id ?? "—"}</span>
              <span className="ck-mono ck-dim">{shortDate(row.reveal_open_at)}</span>
              <span className="ck-mono text-right ck-dim">{row.reveal_block_number ?? "—"}</span>
              <span className="ck-mono ck-dim">
                {row.resolution ? `${row.resolution.outcome} ${formatScore(row.resolution.call_score)}` : row.submission_status}
              </span>
              <span className="ck-mono ck-neg truncate">{row.invalid_reason ?? "—"}</span>
              <span className="ck-mono text-right ck-dim">{shortHex(row.call_id)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CanaryTable({ rows }: { rows: LiveCanaryCheck[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        No canary snapshot
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1050px]">
        <div className="grid grid-cols-[170px_110px_110px_200px_1fr_190px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Check</span>
          <span>Status</span>
          <span className="text-right">Lat</span>
          <span className="text-right">Checked</span>
          <span>Details</span>
          <span>Error</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.name}
              className={
                "grid grid-cols-[170px_110px_110px_200px_1fr_190px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="ck-mono ck-pos">{row.name}</span>
              <span className={`ck-mono ${canaryStatusClass(row.status)}`}>{row.status}</span>
              <span className="ck-mono text-right ck-dim">{formatLatency(row.latency_ms)}</span>
              <span className="ck-mono text-right ck-dim">{shortDate(row.checked_at)}</span>
              <span className="ck-mono ck-dim truncate">{formatDetails(row.details)}</span>
              <span className="ck-mono ck-neg truncate">{row.error ?? "—"}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FeedSlaTable({ rows }: { rows: FeedSlaIncident[] }) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        No open missed-packet incidents
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1207px]">
        <div className="grid grid-cols-[1fr_120px_147px_200px_120px_120px_200px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Feed</span>
          <span className="text-right">Seq</span>
          <span>Status</span>
          <span>Deadline</span>
          <span>Refund</span>
          <span>Slash</span>
          <span className="text-right">Detected</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.incident_id}
              className={
                "grid grid-cols-[1fr_120px_147px_200px_120px_120px_200px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="ck-mono ck-pos truncate">{row.feed_id}</span>
              <span className="ck-mono text-right">{row.expected_sequence}</span>
              <span className={`ck-mono ${row.status === "open" ? "ck-neg" : "ck-dim"}`}>
                {row.status}
              </span>
              <span className="ck-mono ck-dim">{shortDate(row.expected_delivery_deadline_at)}</span>
              <span className="ck-mono ck-dim">{row.refund_action}</span>
              <span className="ck-mono ck-dim">{row.slash_action}</span>
              <span className="ck-mono text-right ck-dim">{shortDate(row.detected_at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function GatewaySummary({ snapshot }: { snapshot: GatewayOperatorSnapshot }) {
  const counts = snapshot.status_counts;
  const feedCounts = snapshot.feed_status_counts;
  const queueStats = [
    ["due", snapshot.queues.due_for_broadcast],
    ["confirm", snapshot.queues.submitted_awaiting_confirmation],
    ["accept", snapshot.queues.confirmed_awaiting_acceptance],
    ["stuck", snapshot.queues.stuck],
  ];
  const feedQueueStats = [
    ["feed due", snapshot.feed_queues.due_for_broadcast],
    ["feed confirm", snapshot.feed_queues.submitted_awaiting_confirmation],
    ["feed accept", snapshot.feed_queues.confirmed_awaiting_acceptance],
    ["feed stuck", snapshot.feed_queues.stuck],
  ];
  return (
    <Panel title="Gateway summary" meta={snapshot.configured ? "configured" : "unconfigured"}>
      <div className="flex flex-col">
        <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-6 gap-3">
          {STATUSES.map((s) => (
            <Stat key={s} label={s.replace("failed_", "fail ")} value={counts[s] ?? 0} tone={toneFor(s)} />
          ))}
        </div>
        <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
          {queueStats.map(([label, value]) => (
            <Stat key={label} label={String(label)} value={Number(value)} tone={label === "stuck" ? "neg" : "dim"} />
          ))}
        </div>
        <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-6 gap-3">
          {STATUSES.map((s) => (
            <Stat key={s} label={`feed ${s.replace("failed_", "fail ")}`} value={feedCounts[s] ?? 0} tone={toneFor(s)} />
          ))}
        </div>
        <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
          {feedQueueStats.map(([label, value]) => (
            <Stat key={label} label={String(label)} value={Number(value)} tone={label === "feed stuck" ? "neg" : "dim"} />
          ))}
        </div>
        <div className="px-3 py-3 border-b border-[var(--color-border)] grid grid-cols-2 md:grid-cols-4 gap-3">
          <Fact label="configured" value={snapshot.configured ? "yes" : "no"} />
          <Fact label="chain" value={snapshot.config?.chain_id ?? "—"} />
          <Fact label="contract" value={shortHex(snapshot.config?.contract_address)} />
          <Fact label="relayer" value={shortHex(snapshot.config?.relayer_address)} />
        </div>
        <div className="px-3 py-3 grid grid-cols-2 md:grid-cols-6 gap-3">
          <Fact label="avg send" value={formatLatency(snapshot.telemetry.avg_broadcast_latency_ms)} />
          <Fact label="avg receipt" value={formatLatency(snapshot.telemetry.avg_receipt_latency_ms)} />
          <Fact label="avg block" value={formatLatency(snapshot.telemetry.avg_latest_block_latency_ms)} />
          <Fact label="max conf" value={snapshot.telemetry.max_confirmations_observed ?? "—"} />
          <Fact label="RPC errs" value={snapshot.telemetry.rpc_errors} />
          <Fact label="feed RPC errs" value={snapshot.feed_telemetry.rpc_errors} />
        </div>
      </div>
    </Panel>
  );
}

function FeedAttemptTable({
  rows,
  busy,
  onRetry,
  empty = "No feed attempts",
}: {
  rows: GatewayOperatorFeedAttempt[];
  busy: string | null;
  onRetry: (attemptId: string) => void;
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        {empty}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1578px]">
        <div className="grid grid-cols-[168px_120px_1fr_1fr_80px_90px_90px_1fr_100px_200px_130px_90px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Status</span>
          <span>Agent</span>
          <span>Feed</span>
          <span>Market</span>
          <span className="text-right">Seq</span>
          <span className="text-right">Lat</span>
          <span className="text-right">Gas</span>
          <span>Tx</span>
          <span className="text-right">Attempts</span>
          <span className="text-right">Updated</span>
          <span>Error</span>
          <span className="text-right">Action</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.attempt_id}
              className={
                "grid grid-cols-[168px_120px_1fr_1fr_80px_90px_90px_1fr_100px_200px_130px_90px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`ck-mono ${statusClass(row.status)}`}>{row.status}</span>
              <span className="ck-mono ck-dim">{row.agent_id.slice(0, 8)}</span>
              <span className="ck-mono ck-pos truncate">{row.feed_id}</span>
              <span className="ck-mono ck-dim truncate">{row.market_id ?? "—"}</span>
              <span className="ck-mono text-right">{row.sequence}</span>
              <span className="ck-mono text-right ck-dim">{formatLatency(row.receipt_latency_ms ?? row.broadcast_latency_ms)}</span>
              <span className="ck-mono text-right ck-dim">{formatGas(row.gas_used)}</span>
              <span className="ck-mono ck-dim truncate">
                {row.tx_hash ? shortHex(row.tx_hash) : "—"}
              </span>
              <span className="ck-mono text-right">{row.attempt_count}</span>
              <span className="ck-mono text-right ck-dim">{shortDate(row.updated_at)}</span>
              <span className="ck-mono ck-neg truncate">{row.last_error ?? "—"}</span>
              <span className="text-right">
                {canRetry(row.status) ? (
                  <button
                    className="ck-btn ck-btn-bracket ck-btn-accent"
                    disabled={busy !== null}
                    onClick={() => onRetry(row.attempt_id)}
                  >
                    {busy === row.attempt_id ? "…" : "retry"}
                  </button>
                ) : (
                  <span className="ck-mono ck-dim">—</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AttemptTable({
  rows,
  busy,
  onRetry,
  empty = "No attempts",
}: {
  rows: GatewayOperatorAttempt[];
  busy: string | null;
  onRetry: (attemptId: string) => void;
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 ck-mono ck-dim">
        {empty}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1398px]">
        <div className="grid grid-cols-[168px_130px_1fr_90px_90px_1fr_120px_200px_130px_90px] gap-3 px-3 py-1.5 ck-colhead border-b border-[var(--color-border)]">
          <span>Status</span>
          <span>Agent</span>
          <span>Market</span>
          <span className="text-right">Lat</span>
          <span className="text-right">Gas</span>
          <span>Tx</span>
          <span className="text-right">Attempts</span>
          <span className="text-right">Updated</span>
          <span>Error</span>
          <span className="text-right">Action</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.attempt_id}
              className={
                "grid grid-cols-[168px_130px_1fr_90px_90px_1fr_120px_200px_130px_90px] gap-3 px-3 py-2 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`ck-mono ${statusClass(row.status)}`}>{row.status}</span>
              <span className="ck-mono ck-dim">{row.agent_id.slice(0, 8)}</span>
              <span className="ck-mono ck-pos truncate">{row.market_id}</span>
              <span className="ck-mono text-right ck-dim">{formatLatency(row.receipt_latency_ms ?? row.broadcast_latency_ms)}</span>
              <span className="ck-mono text-right ck-dim">{formatGas(row.gas_used)}</span>
              <span className="ck-mono ck-dim truncate">
                {row.tx_hash ? shortHex(row.tx_hash) : "—"}
              </span>
              <span className="ck-mono text-right">{row.attempt_count}</span>
              <span className="ck-mono text-right ck-dim">{shortDate(row.updated_at)}</span>
              <span className="ck-mono ck-neg truncate">{row.last_error ?? "—"}</span>
              <span className="text-right">
                {canRetry(row.status) ? (
                  <button
                    className="ck-btn ck-btn-bracket ck-btn-accent"
                    disabled={busy !== null}
                    onClick={() => onRetry(row.attempt_id)}
                  >
                    {busy === row.attempt_id ? "…" : "retry"}
                  </button>
                ) : (
                  <span className="ck-mono ck-dim">—</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
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
            <span className="ck-pos">gateway</span>
          </span></TopbarCrumb>
      <main className="flex-1 min-h-0 flex flex-col p-3">
        <Panel title="Admin token" meta="locked" className="max-w-[560px]">
          <div className="p-3 flex flex-col gap-3">
            {error && <InlineError error={error} className="ck-mono" />}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onSubmit();
              }}
              className="flex flex-col gap-3"
            >
              <label htmlFor="admin-gateway-token" className="ck-label">Admin token</label>
              <input
                id="admin-gateway-token"
                type="password"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="bg-transparent border border-[var(--color-border-vis)] px-2 py-1.5 ck-mono ck-pos focus:outline-none focus:border-[var(--color-display)]"
                placeholder="VERDICT_ADMIN_TOKEN"
                autoFocus
              />
              <div>
                <button className="ck-btn ck-btn-bracket ck-pos" type="submit">unlock</button>
              </div>
            </form>
          </div>
        </Panel>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "dim",
}: {
  label: string;
  value: number | string;
  tone?: "pos" | "neg" | "dim";
}) {
  const cls = tone === "pos"
    ? "ck-pos"
    : tone === "neg"
      ? "ck-neg"
      : "ck-pos";
  return (
    <div className="flex flex-col gap-1">
      <span className="ck-label">{sentenceCase(label)}</span>
      <span className={`ck-mono text-2xl tabular-nums ${cls}`}>{value}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="ck-label">{sentenceCase(label)}</span>
      <span className="ck-mono ck-pos truncate">{String(value)}</span>
    </div>
  );
}

function canRetry(status: GatewayAttemptStatus): boolean {
  return status === "queued" || status === "failed_retryable";
}

function toneFor(status: GatewayAttemptStatus): "pos" | "neg" | "dim" {
  if (status === "accepted") return "pos";
  if (status.startsWith("failed")) return "neg";
  return "dim";
}

function statusClass(status: GatewayAttemptStatus): string {
  if (status === "accepted") return "ck-pos";
  if (status.startsWith("failed")) return "ck-neg";
  if (status === "submitted" || status === "confirmed") return "ck-pos";
  return "ck-dim";
}

function canaryStatusClass(status: LiveCanaryCheck["status"]): string {
  if (status === "ok") return "ck-pos";
  if (status === "fail") return "ck-neg";
  return "ck-dim";
}

function revealStatusClass(status: FhenixLifecycleRow["reveal_status"], overdue: boolean): string {
  if (overdue || status === "invalid" || status === "missed") return "ck-neg";
  if (status === "revealed") return "ck-pos";
  return "ck-dim";
}

function identityStatusClass(status: ControllerIdentityRow["status"]): string {
  if (status === "current") return "ck-pos";
  return "ck-neg";
}

function alertSeverityClass(severity: OperatorAlert["severity"]): string {
  if (severity === "critical") return "ck-neg";
  if (severity === "warning") return "ck-pos";
  return "ck-dim";
}

function feedHealthClass(status: FeedAvailabilitySummary["health_status"]): string {
  if (status === "failing") return "ck-neg";
  if (status === "degraded") return "ck-pos";
  return "ck-dim";
}

function shortHex(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

/** Local instant, zone named, year and seconds left to the wire. */
function shortDate(value: string): string {
  return formatLocalDateTimeShort(value) ?? value;
}

function formatLatency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)}ms`;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatGas(value: string | null | undefined): string {
  if (!value) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatCursor(cursors: FhenixLifecycleSnapshot["cursors"]): string {
  if (cursors.length === 0) return "—";
  const max = Math.max(...cursors.map((cursor) => cursor.last_block_number));
  return `${max}`;
}

function formatDetails(details: LiveCanaryCheck["details"]): string {
  const parts = Object.entries(details)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? parts.join(" / ") : "—";
}
