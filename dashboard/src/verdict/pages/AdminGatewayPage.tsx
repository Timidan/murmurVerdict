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
import { PillButton } from "../components/PillButton.js";
import { Topbar } from "../components/Topbar.js";

const TOKEN_KEY = "murmur-verdict.admin-token.v1";
const STATUSES: GatewayAttemptStatus[] = [
  "queued",
  "submitted",
  "confirmed",
  "accepted",
  "failed_retryable",
  "failed_terminal",
];

export function AdminGatewayPage() {
  const [token, setToken] = useState<string>(() => readToken());
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
      setError((e as Error).message);
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
    writeToken(tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

  const signOut = () => {
    writeToken("");
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
      const data = await verdictApi.adminGatewayTick(token);
      setSnapshot(data.gateway);
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
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="admin · fhenix gateway" />
      <main className="flex-1 max-w-[1380px] w-full mx-auto px-6 md:px-10 py-12">
        <header className="mb-10 flex items-end justify-between flex-wrap gap-4">
          <div>
            <p className="t-label text-[var(--color-secondary)] mb-3">admin · fhenix gateway</p>
            <h1 className="t-heading" style={{ textWrap: "balance" }}>relayer control plane.</h1>
          </div>
          <div className="flex items-center gap-3">
            <a href="#/admin/overview">
              <PillButton variant="secondary">← overview</PillButton>
            </a>
            <PillButton variant="secondary" onClick={() => void load()} disabled={busy !== null}>
              refresh
            </PillButton>
            <PillButton variant="primary" onClick={runTick} disabled={busy !== null || !snapshot?.configured}>
              {busy === "tick" ? "running" : "run tick"}
            </PillButton>
            <PillButton variant="secondary" onClick={signOut}>sign out</PillButton>
          </div>
        </header>

        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-4 mb-8 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}

        {!snapshot && !error && (
          <div className="px-6 py-24 t-meta text-[var(--color-disabled)]">[loading …]</div>
        )}

        {snapshot && (
          <div className="space-y-10">
            <GatewaySummary snapshot={snapshot} />

            <OperatorAlertsPanel snapshot={alerts} busy={busy} onRunTick={runAlertTick} />

            <CanaryPanel snapshot={canaries} busy={busy} onRunTick={runCanaryTick} />

            <RevealLifecyclePanel snapshot={lifecycle} />

            <IdentityPanel snapshot={identity} />

            <FeedSlaPanel response={feedSla} busy={busy} onRunTick={runSlaTick} />

            <section>
              <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <h2 className="t-subheading">attempts</h2>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as GatewayAttemptStatus | "all")}
                  className="bg-transparent border border-[var(--color-border)] px-3 py-2 t-meta text-[var(--color-primary)]"
                >
                  <option value="all">all</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <AttemptTable
                rows={snapshot.recent_attempts}
                busy={busy}
                onRetry={retry}
              />
            </section>

            <section>
              <h2 className="t-subheading mb-4">feed attempts</h2>
              <FeedAttemptTable
                rows={snapshot.feed_recent_attempts}
                busy={busy}
                onRetry={retry}
              />
            </section>

            <section>
              <h2 className="t-subheading mb-4">stuck</h2>
              <AttemptTable
                rows={snapshot.stuck_attempts}
                busy={busy}
                onRetry={retry}
                empty="no stuck submitted or confirmed attempts"
              />
            </section>

            <section>
              <h2 className="t-subheading mb-4">stuck feeds</h2>
              <FeedAttemptTable
                rows={snapshot.feed_stuck_attempts}
                busy={busy}
                onRetry={retry}
                empty="no stuck submitted or confirmed feed attempts"
              />
            </section>
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
    <section>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="t-subheading">operator alerts</h2>
        <div className="flex items-center gap-3">
          <span className="t-meta text-[var(--color-disabled)]">
            sink {snapshot?.sink_configured ? "configured" : "local only"}
          </span>
          <PillButton variant="secondary" onClick={onRunTick} disabled={busy !== null}>
            {busy === "alerts" ? "running" : "run alerts"}
          </PillButton>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-y border-[var(--color-border)] py-5 mb-4">
        <Stat label="open" value={counts?.total ?? 0} tone={(counts?.total ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="critical" value={counts?.critical ?? 0} tone={(counts?.critical ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="warning" value={counts?.warning ?? 0} tone={(counts?.warning ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="info" value={counts?.info ?? 0} tone="dim" />
      </div>
      <OperatorAlertTable rows={rows} />
    </section>
  );
}

function OperatorAlertTable({ rows }: { rows: OperatorAlert[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        no open operator alerts
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[1040px]">
        <div className="grid grid-cols-[110px_130px_170px_1fr_150px_120px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>severity</span>
          <span>source</span>
          <span>kind</span>
          <span>alert</span>
          <span>delivery</span>
          <span className="text-right">seen</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.alert_id}
              className={
                "grid grid-cols-[110px_130px_170px_1fr_150px_120px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`t-meta ${alertSeverityClass(row.severity)}`}>{row.severity}</span>
              <span className="t-meta text-[var(--color-secondary)]">{row.source}</span>
              <span className="t-meta text-[var(--color-secondary)] truncate">{row.kind}</span>
              <span>
                <span className="block t-meta text-[var(--color-display)]">{row.title}</span>
                <span className="block t-meta text-[var(--color-disabled)] truncate">{row.description}</span>
              </span>
              <span className="t-meta text-[var(--color-secondary)]">
                {row.delivery_status} · {row.delivery_attempts}
              </span>
              <span className="t-meta text-right text-[var(--color-disabled)]">{shortDate(row.last_seen_at)}</span>
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
    <section>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="t-subheading">feed SLA incidents</h2>
        <PillButton variant="secondary" onClick={onRunTick} disabled={busy !== null}>
          {busy === "sla" ? "running" : "run sla tick"}
        </PillButton>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-y border-[var(--color-border)] py-5 mb-4">
        <Stat label="open missed" value={summary?.open_incidents ?? rows.length} tone={(summary?.open_incidents ?? rows.length) > 0 ? "neg" : "dim"} />
        <Stat label="refund recs" value={summary?.refund_recommendations ?? 0} tone={(summary?.refund_recommendations ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="slash recs" value={summary?.slash_recommendations ?? 0} tone={(summary?.slash_recommendations ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="pay exec" value={summary?.payment_execution_enabled ? "on" : "off"} tone="dim" />
      </div>
      <FeedHealthTable rows={health} />
      <FeedSlaTable rows={rows} />
    </section>
  );
}

function FeedHealthTable({ rows }: { rows: FeedAvailabilitySummary[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-8 mb-4 t-meta text-[var(--color-disabled)]">
        no listed cadence feeds
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)] mb-4">
      <div className="min-w-[1060px]">
        <div className="grid grid-cols-[1fr_120px_110px_120px_130px_160px_130px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>feed</span>
          <span>health</span>
          <span className="text-right">rel</span>
          <span className="text-right">missed</span>
          <span className="text-right">next seq</span>
          <span>next deadline</span>
          <span className="text-right">proof</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.feed_id}
              className={
                "grid grid-cols-[1fr_120px_110px_120px_130px_160px_130px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="t-meta font-mono text-[var(--color-display)] truncate">{row.feed_id}</span>
              <span className={`t-meta ${feedHealthClass(row.health_status)}`}>{row.overdue ? "overdue" : row.health_status}</span>
              <span className="t-data text-right">{formatPercent(row.reliability_score)}</span>
              <span className="t-data text-right">{row.open_missed_packets}/{row.missed_packets}</span>
              <span className="t-data text-right">{row.next_expected_sequence ?? "—"}</span>
              <span className="t-meta text-[var(--color-secondary)]">{row.next_deadline_at ? shortDate(row.next_deadline_at) : "—"}</span>
              <span className="t-meta text-right font-mono text-[var(--color-disabled)]">{row.proof_hash.slice(0, 10)}</span>
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
    <section>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="t-subheading">controller wallets</h2>
        <span className="t-meta text-[var(--color-disabled)]">
          due by {snapshot ? shortDate(snapshot.due_soon_at) : "—"}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 border-y border-[var(--color-border)] py-5 mb-4">
        <Stat label="bound" value={snapshot?.counts.controller_wallets ?? 0} tone="dim" />
        <Stat label="active keys" value={snapshot?.counts.active_runtime_keys ?? 0} tone="dim" />
        <Stat label="due soon" value={snapshot?.counts.due_soon ?? 0} tone={(snapshot?.counts.due_soon ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="overdue" value={snapshot?.counts.overdue ?? 0} tone={(snapshot?.counts.overdue ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="attention" value={snapshot?.counts.needs_attention ?? 0} tone={(snapshot?.counts.needs_attention ?? 0) > 0 ? "neg" : "dim"} />
      </div>
      <IdentityTable rows={rows} />
    </section>
  );
}

function IdentityTable({ rows }: { rows: ControllerIdentityRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        no controller wallets need re-attestation
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[1040px]">
        <div className="grid grid-cols-[120px_130px_1fr_130px_130px_90px_90px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>status</span>
          <span>agent</span>
          <span>wallet</span>
          <span>kind</span>
          <span className="text-right">due</span>
          <span className="text-right">keys</span>
          <span className="text-right">revoked</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.agent_id}
              className={
                "grid grid-cols-[120px_130px_1fr_130px_130px_90px_90px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`t-meta ${identityStatusClass(row.status)}`}>{row.status}</span>
              <span className="t-meta font-mono text-[var(--color-display)] truncate">{row.agent_slug ?? row.agent_id.slice(0, 8)}</span>
              <span className="t-meta font-mono text-[var(--color-secondary)] truncate">{shortHex(row.wallet_address)}</span>
              <span className="t-meta text-[var(--color-secondary)]">{row.wallet_kind}{row.provider ? `/${row.provider}` : ""}</span>
              <span className="t-meta text-right text-[var(--color-disabled)]">{row.reattestation_due_at ? shortDate(row.reattestation_due_at) : "—"}</span>
              <span className="t-data text-right">{row.active_runtime_keys}/{row.total_runtime_keys}</span>
              <span className="t-data text-right">{row.revoked_runtime_keys}</span>
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
    <section>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="t-subheading">live canaries</h2>
        <PillButton variant="secondary" onClick={onRunTick} disabled={busy !== null}>
          {busy === "canaries" ? "running" : "run canaries"}
        </PillButton>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-y border-[var(--color-border)] py-5 mb-4">
        <Stat label="total" value={rows.length} tone={snapshot?.ok ? "pos" : "neg"} />
        <Stat label="ok" value={ok} tone={ok > 0 ? "pos" : "dim"} />
        <Stat label="fail" value={failing} tone={failing > 0 ? "neg" : "dim"} />
        <Stat label="disabled" value={disabled} tone="dim" />
      </div>
      <CanaryTable rows={rows} />
    </section>
  );
}

function RevealLifecyclePanel({ snapshot }: { snapshot: FhenixLifecycleSnapshot | null }) {
  const counts = snapshot?.counts;
  const attention = snapshot?.needs_attention ?? [];
  const cursors = snapshot?.cursors ?? [];
  return (
    <section>
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="t-subheading">reveal lifecycle</h2>
        <span className="t-meta text-[var(--color-disabled)]">
          grace {snapshot?.configured.reveal_grace_seconds ?? "—"}s
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 border-y border-[var(--color-border)] py-5 mb-4">
        <Stat label="pending" value={counts?.pending ?? 0} tone={(counts?.pending ?? 0) > 0 ? "dim" : "pos"} />
        <Stat label="revealed" value={counts?.revealed ?? 0} tone="pos" />
        <Stat label="invalid" value={counts?.invalid ?? 0} tone={(counts?.invalid ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="missed" value={counts?.missed ?? 0} tone={(counts?.missed ?? 0) > 0 ? "neg" : "dim"} />
        <Stat label="attention" value={snapshot?.queues.needs_attention ?? 0} tone={(snapshot?.queues.needs_attention ?? 0) > 0 ? "neg" : "dim"} />
      </div>
      <div className="border-y border-[var(--color-border)] py-5 grid md:grid-cols-4 gap-4 t-meta mb-4">
        <Fact label="verifier" value={snapshot?.configured.verifier ? "yes" : "no"} />
        <Fact label="watcher" value={snapshot?.configured.watcher ? "yes" : "no"} />
        <Fact label="overdue" value={snapshot?.queues.overdue_grace ?? 0} />
        <Fact label="cursor" value={formatCursor(cursors)} />
      </div>
      <RevealLifecycleTable rows={attention} />
    </section>
  );
}

function RevealLifecycleTable({ rows }: { rows: FhenixLifecycleRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        no reveal lifecycle rows need attention
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[1180px]">
        <div className="grid grid-cols-[110px_120px_1fr_150px_110px_120px_1fr_130px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>status</span>
          <span>agent</span>
          <span>market</span>
          <span>reveal open</span>
          <span className="text-right">block</span>
          <span>resolution</span>
          <span>reason</span>
          <span className="text-right">call</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.call_id}
              className={
                "grid grid-cols-[110px_120px_1fr_150px_110px_120px_1fr_130px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`t-meta ${revealStatusClass(row.reveal_status, row.overdue_grace)}`}>
                {row.overdue_grace ? "overdue" : row.reveal_status}
              </span>
              <span className="t-meta font-mono text-[var(--color-secondary)]">{row.agent_slug ?? row.agent_id.slice(0, 8)}</span>
              <span className="t-meta font-mono text-[var(--color-display)] truncate">{row.market_id ?? "—"}</span>
              <span className="t-meta text-[var(--color-secondary)]">{shortDate(row.reveal_open_at)}</span>
              <span className="t-meta text-right text-[var(--color-secondary)]">{row.reveal_block_number ?? "—"}</span>
              <span className="t-meta text-[var(--color-secondary)]">
                {row.resolution ? `${row.resolution.outcome} ${formatScore(row.resolution.call_score)}` : row.submission_status}
              </span>
              <span className="t-meta text-[var(--color-accent)] truncate">{row.invalid_reason ?? "—"}</span>
              <span className="t-meta text-right font-mono text-[var(--color-disabled)]">{shortHex(row.call_id)}</span>
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
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        no canary snapshot
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[980px]">
        <div className="grid grid-cols-[170px_110px_110px_130px_1fr_190px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>check</span>
          <span>status</span>
          <span className="text-right">lat</span>
          <span className="text-right">checked</span>
          <span>details</span>
          <span>error</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.name}
              className={
                "grid grid-cols-[170px_110px_110px_130px_1fr_190px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="t-meta font-mono text-[var(--color-display)]">{row.name}</span>
              <span className={`t-meta ${canaryStatusClass(row.status)}`}>{row.status}</span>
              <span className="t-meta text-right text-[var(--color-secondary)]">{formatLatency(row.latency_ms)}</span>
              <span className="t-meta text-right text-[var(--color-disabled)]">{shortDate(row.checked_at)}</span>
              <span className="t-meta text-[var(--color-secondary)] truncate">{formatDetails(row.details)}</span>
              <span className="t-meta text-[var(--color-accent)] truncate">{row.error ?? "—"}</span>
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
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        no open missed-packet incidents
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[1060px]">
        <div className="grid grid-cols-[1fr_120px_120px_150px_120px_120px_130px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>feed</span>
          <span className="text-right">seq</span>
          <span>status</span>
          <span>deadline</span>
          <span>refund</span>
          <span>slash</span>
          <span className="text-right">detected</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.incident_id}
              className={
                "grid grid-cols-[1fr_120px_120px_150px_120px_120px_130px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className="t-meta font-mono text-[var(--color-display)] truncate">{row.feed_id}</span>
              <span className="t-data text-right">{row.expected_sequence}</span>
              <span className={`t-meta ${row.status === "open" ? "text-[var(--color-accent)]" : "text-[var(--color-secondary)]"}`}>
                {row.status}
              </span>
              <span className="t-meta text-[var(--color-secondary)]">{shortDate(row.expected_delivery_deadline_at)}</span>
              <span className="t-meta text-[var(--color-secondary)]">{row.refund_action}</span>
              <span className="t-meta text-[var(--color-secondary)]">{row.slash_action}</span>
              <span className="t-meta text-right text-[var(--color-disabled)]">{shortDate(row.detected_at)}</span>
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
    <section className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
      <div className="border-y border-[var(--color-border)] py-5">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          {STATUSES.map((s) => (
            <Stat key={s} label={s.replace("failed_", "fail ")} value={counts[s] ?? 0} tone={toneFor(s)} />
          ))}
        </div>
      </div>
      <div className="border-y border-[var(--color-border)] py-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {queueStats.map(([label, value]) => (
            <Stat key={label} label={String(label)} value={Number(value)} tone={label === "stuck" ? "neg" : "dim"} />
          ))}
        </div>
      </div>
      <div className="border-y border-[var(--color-border)] py-5">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          {STATUSES.map((s) => (
            <Stat key={s} label={`feed ${s.replace("failed_", "fail ")}`} value={feedCounts[s] ?? 0} tone={toneFor(s)} />
          ))}
        </div>
      </div>
      <div className="border-y border-[var(--color-border)] py-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {feedQueueStats.map(([label, value]) => (
            <Stat key={label} label={String(label)} value={Number(value)} tone={label === "feed stuck" ? "neg" : "dim"} />
          ))}
        </div>
      </div>
      <div className="lg:col-span-2 border-y border-[var(--color-border)] py-5 grid md:grid-cols-4 gap-4 t-meta">
        <Fact label="configured" value={snapshot.configured ? "yes" : "no"} />
        <Fact label="chain" value={snapshot.config?.chain_id ?? "—"} />
        <Fact label="contract" value={shortHex(snapshot.config?.contract_address)} />
        <Fact label="relayer" value={shortHex(snapshot.config?.relayer_address)} />
      </div>
      <div className="lg:col-span-2 border-y border-[var(--color-border)] py-5 grid md:grid-cols-6 gap-4 t-meta">
        <Fact label="avg send" value={formatLatency(snapshot.telemetry.avg_broadcast_latency_ms)} />
        <Fact label="avg receipt" value={formatLatency(snapshot.telemetry.avg_receipt_latency_ms)} />
        <Fact label="avg block" value={formatLatency(snapshot.telemetry.avg_latest_block_latency_ms)} />
        <Fact label="max conf" value={snapshot.telemetry.max_confirmations_observed ?? "—"} />
        <Fact label="rpc errs" value={snapshot.telemetry.rpc_errors} />
        <Fact label="feed rpc errs" value={snapshot.feed_telemetry.rpc_errors} />
      </div>
    </section>
  );
}

function FeedAttemptTable({
  rows,
  busy,
  onRetry,
  empty = "no feed attempts",
}: {
  rows: GatewayOperatorFeedAttempt[];
  busy: string | null;
  onRetry: (attemptId: string) => void;
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        {empty}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[1460px]">
        <div className="grid grid-cols-[130px_120px_1fr_1fr_80px_90px_90px_1fr_100px_120px_130px_90px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>status</span>
          <span>agent</span>
          <span>feed</span>
          <span>market</span>
          <span className="text-right">seq</span>
          <span className="text-right">lat</span>
          <span className="text-right">gas</span>
          <span>tx</span>
          <span className="text-right">attempts</span>
          <span className="text-right">updated</span>
          <span>error</span>
          <span className="text-right">action</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.attempt_id}
              className={
                "grid grid-cols-[130px_120px_1fr_1fr_80px_90px_90px_1fr_100px_120px_130px_90px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`t-meta ${statusClass(row.status)}`}>{row.status}</span>
              <span className="t-meta font-mono text-[var(--color-secondary)]">{row.agent_id.slice(0, 8)}</span>
              <span className="t-meta font-mono text-[var(--color-display)] truncate">{row.feed_id}</span>
              <span className="t-meta font-mono text-[var(--color-secondary)] truncate">{row.market_id ?? "—"}</span>
              <span className="t-data text-right">{row.sequence}</span>
              <span className="t-meta text-right text-[var(--color-secondary)]">{formatLatency(row.receipt_latency_ms ?? row.broadcast_latency_ms)}</span>
              <span className="t-meta text-right text-[var(--color-secondary)]">{formatGas(row.gas_used)}</span>
              <span className="t-meta font-mono text-[var(--color-secondary)] truncate">
                {row.tx_hash ? shortHex(row.tx_hash) : "—"}
              </span>
              <span className="t-data text-right">{row.attempt_count}</span>
              <span className="t-meta text-right text-[var(--color-disabled)]">{shortDate(row.updated_at)}</span>
              <span className="t-meta text-[var(--color-accent)] truncate">{row.last_error ?? "—"}</span>
              <span className="text-right">
                {canRetry(row.status) ? (
                  <button
                    className="t-button text-[var(--color-accent)] hover:underline press-feedback"
                    disabled={busy !== null}
                    onClick={() => onRetry(row.attempt_id)}
                  >
                    {busy === row.attempt_id ? "…" : "retry"}
                  </button>
                ) : (
                  <span className="t-meta text-[var(--color-disabled)]">—</span>
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
  empty = "no attempts",
}: {
  rows: GatewayOperatorAttempt[];
  busy: string | null;
  onRetry: (attemptId: string) => void;
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-[var(--color-border)] px-6 py-12 t-meta text-[var(--color-disabled)]">
        {empty}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-[var(--color-border)]">
      <div className="min-w-[1280px]">
        <div className="grid grid-cols-[130px_130px_1fr_90px_90px_1fr_120px_120px_130px_90px] gap-4 px-6 py-2 t-meta border-b border-[var(--color-border)]">
          <span>status</span>
          <span>agent</span>
          <span>market</span>
          <span className="text-right">lat</span>
          <span className="text-right">gas</span>
          <span>tx</span>
          <span className="text-right">attempts</span>
          <span className="text-right">updated</span>
          <span>error</span>
          <span className="text-right">action</span>
        </div>
        <ul className="m-0 p-0 list-none">
          {rows.map((row, i) => (
            <li
              key={row.attempt_id}
              className={
                "grid grid-cols-[130px_130px_1fr_90px_90px_1fr_120px_120px_130px_90px] gap-4 px-6 py-4 items-center " +
                (i > 0 ? "border-t border-[var(--color-border)]" : "")
              }
            >
              <span className={`t-meta ${statusClass(row.status)}`}>{row.status}</span>
              <span className="t-meta font-mono text-[var(--color-secondary)]">{row.agent_id.slice(0, 8)}</span>
              <span className="t-meta font-mono text-[var(--color-display)] truncate">{row.market_id}</span>
              <span className="t-meta text-right text-[var(--color-secondary)]">{formatLatency(row.receipt_latency_ms ?? row.broadcast_latency_ms)}</span>
              <span className="t-meta text-right text-[var(--color-secondary)]">{formatGas(row.gas_used)}</span>
              <span className="t-meta font-mono text-[var(--color-secondary)] truncate">
                {row.tx_hash ? shortHex(row.tx_hash) : "—"}
              </span>
              <span className="t-data text-right">{row.attempt_count}</span>
              <span className="t-meta text-right text-[var(--color-disabled)]">{shortDate(row.updated_at)}</span>
              <span className="t-meta text-[var(--color-accent)] truncate">{row.last_error ?? "—"}</span>
              <span className="text-right">
                {canRetry(row.status) ? (
                  <button
                    className="t-button text-[var(--color-accent)] hover:underline press-feedback"
                    disabled={busy !== null}
                    onClick={() => onRetry(row.attempt_id)}
                  >
                    {busy === row.attempt_id ? "…" : "retry"}
                  </button>
                ) : (
                  <span className="t-meta text-[var(--color-disabled)]">—</span>
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
    <div className="min-h-dvh flex flex-col bg-[var(--color-bg)] text-[var(--color-primary)]">
      <Topbar crumb="admin · fhenix gateway" />
      <main className="flex-1 max-w-[640px] w-full mx-auto px-6 md:px-10 py-12">
        <p className="t-label text-[var(--color-secondary)] mb-3">admin</p>
        <h1 className="t-heading mb-6">gateway token.</h1>
        {error && (
          <div className="border border-[var(--color-accent)] px-6 py-4 mb-6 t-body-sm text-[var(--color-accent)]">
            [ERROR] {error}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <label htmlFor="admin-gateway-token" className="ck-label">admin token</label>
          <input
            id="admin-gateway-token"
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="bg-transparent border-b border-[var(--color-border-vis)] py-2 t-body font-mono text-[var(--color-display)] focus:outline-none focus:border-[var(--color-display)]"
            placeholder="VERDICT_ADMIN_TOKEN"
            autoFocus
          />
          <PillButton variant="primary" type="submit">unlock</PillButton>
        </form>
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
    ? "text-[var(--color-display)]"
    : tone === "neg"
      ? "text-[var(--color-accent)]"
      : "text-[var(--color-display)]";
  return (
    <div>
      <p className="t-meta text-[var(--color-secondary)] mb-2">{label}</p>
      <p className={`t-data text-2xl ${cls}`}>{value}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[var(--color-secondary)] mb-2">{label}</p>
      <p className="font-mono text-[var(--color-display)] truncate">{String(value)}</p>
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
  if (status === "accepted") return "text-[var(--color-display)]";
  if (status.startsWith("failed")) return "text-[var(--color-accent)]";
  if (status === "submitted" || status === "confirmed") return "text-[var(--color-display)]";
  return "text-[var(--color-secondary)]";
}

function canaryStatusClass(status: LiveCanaryCheck["status"]): string {
  if (status === "ok") return "text-[var(--color-display)]";
  if (status === "fail") return "text-[var(--color-accent)]";
  return "text-[var(--color-secondary)]";
}

function revealStatusClass(status: FhenixLifecycleRow["reveal_status"], overdue: boolean): string {
  if (overdue || status === "invalid" || status === "missed") return "text-[var(--color-accent)]";
  if (status === "revealed") return "text-[var(--color-display)]";
  return "text-[var(--color-secondary)]";
}

function identityStatusClass(status: ControllerIdentityRow["status"]): string {
  if (status === "current") return "text-[var(--color-display)]";
  return "text-[var(--color-accent)]";
}

function alertSeverityClass(severity: OperatorAlert["severity"]): string {
  if (severity === "critical") return "text-[var(--color-accent)]";
  if (severity === "warning") return "text-[var(--color-display)]";
  return "text-[var(--color-secondary)]";
}

function feedHealthClass(status: FeedAvailabilitySummary["health_status"]): string {
  if (status === "failing") return "text-[var(--color-accent)]";
  if (status === "degraded") return "text-[var(--color-display)]";
  return "text-[var(--color-secondary)]";
}

function shortHex(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function shortDate(value: string): string {
  return value.slice(5, 16).replace("T", " ");
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

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value >= 0 ? `+${value.toFixed(3)}` : value.toFixed(3);
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

function readToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(value: string): void {
  try {
    if (value) window.localStorage.setItem(TOKEN_KEY, value);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage disabled
  }
}
