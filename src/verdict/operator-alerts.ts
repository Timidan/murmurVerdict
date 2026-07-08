import type Database from "better-sqlite3";

import type { LiveCanaryProvider } from "../integrations/live-canaries.js";
import {
  operatorAlertsRepo,
  type OperatorAlertInput,
  type OperatorAlertIdAdapter,
} from "./repos/operator-alerts-repo.js";
import { nowIso } from "./time.js";
import { collectOperatorAlertSources } from "./operator-alert-sources.js";
import {
  deliverOperatorAlerts,
  type OperatorAlertDeliveryResult,
  type OperatorAlertSinkConfig,
} from "./operator-alert-delivery.js";
import {
  alertCountSummary,
  operatorAlertsSnapshot,
  type AlertCountSummary,
  type OperatorAlertsSnapshot,
} from "./operator-alert-presenters.js";

export {
  deliverOperatorAlerts,
  loadOperatorAlertSinkConfig,
  OperatorAlertSinkConfigError,
  operatorAlertSinkFromEnv,
  type OperatorAlertDeliveryFetch,
  type OperatorAlertDeliveryResult,
  type OperatorAlertDeliveryTimers,
  type OperatorAlertSinkConfig,
} from "./operator-alert-delivery.js";
export {
  operatorAlertsSnapshot,
  publicOperatorAlert,
  type AlertCountSummary,
  type OperatorAlertsSnapshot,
  type PublicOperatorAlert,
} from "./operator-alert-presenters.js";
export type { OperatorAlertIdAdapter } from "./repos/operator-alerts-repo.js";

export interface OperatorAlertScanOptions {
  db: Database.Database;
  now: () => Date;
  liveCanaries?: LiveCanaryProvider | null;
  gatewayStuckAfterMs?: number;
  fhenixRevealGraceSec?: number;
  identityDueSoonHours?: number;
  newAlertId?: OperatorAlertIdAdapter;
}

export interface OperatorAlertScanResult {
  served_at: string;
  sources: Array<{
    source: string;
    active_alerts: number;
    resolved_alerts: number;
  }>;
  opened_or_seen: number;
  open_counts: AlertCountSummary;
}

export interface OperatorAlertTickResult {
  scan: OperatorAlertScanResult;
  delivery: OperatorAlertDeliveryResult;
  snapshot: OperatorAlertsSnapshot;
}

export function runOperatorAlertTick(
  opts: OperatorAlertScanOptions & { sink?: OperatorAlertSinkConfig },
): Promise<OperatorAlertTickResult> {
  const servedAt = opts.now();
  const tickClock = () => servedAt;
  const scan = runOperatorAlertScan({
    ...opts,
    now: tickClock,
  });
  return deliverOperatorAlerts({
    db: opts.db,
    sink: opts.sink,
    deliveredAt: servedAt,
  }).then((delivery) => ({
    scan,
    delivery,
    snapshot: operatorAlertsSnapshot(opts.db, {
      status: "open",
      limit: 100,
      sink: opts.sink,
      servedAt,
    }),
  }));
}

export function runOperatorAlertScan(opts: OperatorAlertScanOptions): OperatorAlertScanResult {
  const servedAt = nowIso(opts.now());
  const sources: OperatorAlertScanResult["sources"] = [];
  let openedOrSeen = 0;

  const scanSource = (source: string, alerts: OperatorAlertInput[]) => {
    const keys = alerts.map((alert) => alert.alert_key);
    for (const alert of alerts) {
      operatorAlertsRepo.upsertOpen(opts.db, alert, {
        newAlertId: opts.newAlertId,
      });
      openedOrSeen++;
    }
    const resolved = operatorAlertsRepo.resolveSourceExcept(opts.db, source, keys, servedAt);
    sources.push({ source, active_alerts: alerts.length, resolved_alerts: resolved });
  };

  for (const batch of collectOperatorAlertSources({
    db: opts.db,
    servedAt,
    liveCanaries: opts.liveCanaries,
    gatewayStuckAfterMs: opts.gatewayStuckAfterMs,
    fhenixRevealGraceSec: opts.fhenixRevealGraceSec,
    identityDueSoonHours: opts.identityDueSoonHours,
  })) {
    scanSource(batch.source, batch.alerts);
  }

  return {
    served_at: servedAt,
    sources,
    opened_or_seen: openedOrSeen,
    open_counts: alertCountSummary(opts.db),
  };
}
