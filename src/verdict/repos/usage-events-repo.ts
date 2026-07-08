import type Database from "better-sqlite3";

import { prep } from "../db-statements.js";
import { publicActivityWindow } from "../public-activity-window.js";
import { usageEventAttributesJson } from "../usage-event.js";
import type {
  UsageEvent,
  UsageEventKind,
} from "../schema.js";

export const usageRepo = {
  emit(db: Database.Database, event: UsageEvent): void {
    prep(
      db,
      `INSERT INTO usage_events (event_id, agent_id, kind, ts, attributes_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      event.event_id,
      event.agent_id ?? null,
      event.kind,
      event.ts,
      usageEventAttributesJson(event.attributes),
    );
  },

  count24h(db: Database.Database, kind: UsageEventKind, now: Date): number {
    const activityWindow = publicActivityWindow(now);
    const row = prep(
      db,
      `SELECT COUNT(*) AS n FROM usage_events
       WHERE kind = ? AND ts >= ?`,
    ).get(kind, activityWindow.since_iso) as { n: number } | undefined;
    return row?.n ?? 0;
  },
};
