import type Database from "better-sqlite3";

export const DESTINATION_ADDRESS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface SetDestinationAddressInput {
  agent_id: string;
  destination_address: string;
  updatedAt: Date;
  cooldownMs?: number;
}

export type SetDestinationResult =
  | {
      ok: true;
      previous_address: string | null;
      updated_at: string;
    }
  | {
      ok: false;
      reason: "cooldown_active";
      retry_after_seconds: number;
    }
  | {
      ok: false;
      reason: "agent_not_found";
    };

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

export function setDestinationAddress(
  db: Database.Database,
  input: SetDestinationAddressInput,
): SetDestinationResult {
  const cooldownMs = input.cooldownMs ?? DESTINATION_ADDRESS_COOLDOWN_MS;

  const txn = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT destination_address, destination_address_updated_at FROM agents WHERE agent_id = ?",
      )
      .get(input.agent_id) as
      | {
          destination_address: string | null;
          destination_address_updated_at: string | null;
        }
      | undefined;
    if (!row) {
      return { ok: false as const, reason: "agent_not_found" as const };
    }
    if (row.destination_address_updated_at) {
      const last = Date.parse(row.destination_address_updated_at);
      if (Number.isFinite(last)) {
        const elapsed = input.updatedAt.getTime() - last;
        if (elapsed < cooldownMs) {
          const retry = Math.ceil((cooldownMs - elapsed) / 1000);
          return {
            ok: false as const,
            reason: "cooldown_active" as const,
            retry_after_seconds: retry,
          };
        }
      }
    }
    const ts = stripIso(input.updatedAt);
    db.prepare(
      `UPDATE agents
       SET destination_address = ?, destination_address_updated_at = ?
       WHERE agent_id = ?`,
    ).run(input.destination_address, ts, input.agent_id);
    return {
      ok: true as const,
      previous_address: row.destination_address,
      updated_at: ts,
    };
  });

  return txn();
}
