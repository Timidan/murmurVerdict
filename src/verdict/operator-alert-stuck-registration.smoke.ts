import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "./db.js";
import { collectOperatorAlertSources } from "./operator-alert-sources.js";
import { polymarketDiscoveryRepo } from "./repos/polymarket-discovery-repo.js";

process.stdout.write("murmur stuck registration alert smoke\n");

/**
 * A never-confirming registration stays `broadcasting`. Asserts it alerts, aged from a
 * watermark that error-recording doesn't rewrite.
 */

const tmp = mkdtempSync(join(tmpdir(), "stuck-reg-"));
const db = openDb({ path: join(tmp, `${randomUUID()}.db`) });

const COND = "0x" + "7f".repeat(32);
const BROADCAST_AT = "2026-07-26T00:00:00.000Z";

polymarketDiscoveryRepo.upsertDraft(db, {
  condition_id: COND,
  question: "Bitcoin Up or Down - July 26, 2:40AM-2:45AM ET",
  slug: "btc-updown-5m",
  end_date_epoch_s: Math.floor(Date.parse("2026-07-26T02:45:00Z") / 1000),
  now_iso: BROADCAST_AT,
});
polymarketDiscoveryRepo.markBroadcasting(db, { condition_id: COND, now_iso: BROADCAST_AT });
polymarketDiscoveryRepo.recordBroadcastHash(db, {
  condition_id: COND,
  tx_hash: "0x" + "ab".repeat(32),
  now_iso: BROADCAST_AT,
});

// Freshly broadcast: not yet an alert.
{
  const alerts = collectOperatorAlertSources({ db, servedAt: "2026-07-26T00:01:00.000Z" })
    .flatMap((b) => b.alerts);
  assert.equal(
    alerts.filter((a) => a.kind === "polymarket_discovery_registration_stuck").length,
    0,
    "a recently broadcast registration is not yet stuck",
  );
}

// Recording an error (which rewrites `updated_at`) must not reset the stuck age.
polymarketDiscoveryRepo.recordError(db, {
  condition_id: COND,
  error: "broadcast_unconfirmed_past_grace",
  now_iso: "2026-07-26T00:20:00.000Z",
});

{
  const alerts = collectOperatorAlertSources({ db, servedAt: "2026-07-26T00:21:00.000Z" })
    .flatMap((b) => b.alerts);
  const stuck = alerts.filter(
    (a) => a.kind === "polymarket_discovery_registration_stuck",
  );
  assert.equal(stuck.length, 1, "a 21-minute stuck registration raises an alert");
  assert.equal(stuck[0]?.severity, "warning");
  assert.ok(
    /original nonce/i.test(stuck[0]?.description ?? ""),
    "the alert states the actual remedy — replace at the original nonce",
  );
}

// Past the critical threshold it escalates.
{
  const alerts = collectOperatorAlertSources({ db, servedAt: "2026-07-26T00:45:00.000Z" })
    .flatMap((b) => b.alerts);
  const stuck = alerts.filter(
    (a) => a.kind === "polymarket_discovery_registration_stuck",
  );
  assert.equal(stuck[0]?.severity, "critical", "45 minutes stuck is critical");
}

// A replacement attempt restarts the clock instead of inheriting the dead attempt's age.
{
  polymarketDiscoveryRepo.markBroadcasting(db, {
    condition_id: COND,
    now_iso: "2026-07-26T00:50:00.000Z",
    resetWatermark: true,
  });
  const alerts = collectOperatorAlertSources({ db, servedAt: "2026-07-26T00:51:00.000Z" })
    .flatMap((b) => b.alerts);
  assert.equal(
    alerts.filter((a) => a.kind === "polymarket_discovery_registration_stuck").length,
    0,
    "a fresh replacement attempt does not inherit the previous attempt's stuck age",
  );
}

// A row broadcasting when migration 066 ran still gets a real age. Drives the real migration
// (openDb from a simulated v65) so the backfill itself is tested.
{
  const upgradeTmp = mkdtempSync(join(tmpdir(), "stuck-upgrade-"));
  const upgradePath = join(upgradeTmp, "verdict.db");
  const stale = "0x" + "8e".repeat(32);

  {
    const seeded = openDb({ path: upgradePath });
    polymarketDiscoveryRepo.upsertDraft(seeded, {
      condition_id: stale,
      question: "Bitcoin Up or Down - July 26, 3:00AM-3:05AM ET",
      slug: "btc-updown-5m",
      end_date_epoch_s: Math.floor(Date.parse("2026-07-26T03:05:00Z") / 1000),
      now_iso: "2026-07-26T00:00:00.000Z",
    });
    polymarketDiscoveryRepo.markBroadcasting(seeded, {
      condition_id: stale,
      now_iso: "2026-07-26T00:00:00.000Z",
    });
    // Rewind to the pre-066 shape.
    seeded.exec("ALTER TABLE polymarket_discovery_state DROP COLUMN broadcast_started_at");
    seeded.prepare("UPDATE schema_meta SET value='65' WHERE key='schema_version'").run();
    seeded.close();
  }

  // Reopening runs migration 066 for real, including its backfill.
  const upgraded = openDb({ path: upgradePath });
  const row = upgraded
    .prepare("SELECT broadcast_started_at FROM polymarket_discovery_state WHERE condition_id = ?")
    .get(stale) as { broadcast_started_at: string | null };
  assert.equal(
    row.broadcast_started_at,
    "2026-07-26T00:00:00.000Z",
    "migration 066 backfills rows already broadcasting at upgrade time",
  );

  const alerts = collectOperatorAlertSources({ db: upgraded, servedAt: "2026-07-26T00:40:00.000Z" })
    .flatMap((b) => b.alerts);
  assert.ok(
    alerts.some(
      (a) =>
        a.kind === "polymarket_discovery_registration_stuck" &&
        a.alert_key.endsWith(stale),
    ),
    "an upgraded pre-066 broadcasting row alerts on its real age",
  );
  upgraded.close();
  rmSync(upgradeTmp, { recursive: true, force: true });
}

db.close();
rmSync(tmp, { recursive: true, force: true });
process.stdout.write("OK stuck registration alert smoke\n");
