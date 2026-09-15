import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
  type ControllerWalletKind,
} from "../controller-wallet.js";

export interface ControllerWalletRow {
  agent_id: string;
  account_id: string;
  wallet_address: string;
  chain_id: string;
  wallet_kind: ControllerWalletKind;
  provider: string | null;
  binding_message: string;
  binding_signature: string;
  created_at: string;
  last_attested_at: string | null;
  reattestation_due_at: string | null;
  last_reattestation_nonce: string | null;
  last_reattestation_message: string | null;
  last_reattestation_signature: string | null;
}

export interface ControllerWalletReattestationRow {
  attestation_id: string;
  account_id: string;
  agent_id: string;
  wallet_address: string;
  chain_id: string;
  attestation_nonce: string;
  attestation_message: string;
  attestation_signature: string;
  attested_at: string;
  next_due_at: string;
}

export type ControllerWalletReattestationHealthStatus =
  | "current"
  | "due_soon"
  | "overdue";

export type ControllerWalletReattestationIdAdapter = () => string;

export interface ControllerWalletAttestationStatus {
  last_attested_at: string;
  reattestation_due_at: string;
  reattestation_overdue: boolean;
  reattestation_interval_seconds: number;
}

export interface ControllerWalletReattestationHealth
  extends ControllerWalletAttestationStatus {
  status: ControllerWalletReattestationHealthStatus;
  reattestation_due_soon: boolean;
}

export interface ControllerWalletAttestationStatusInput {
  checkedAt: Date;
}

export interface ControllerWalletReattestationHealthInput
  extends ControllerWalletAttestationStatusInput {
  dueSoonAt?: string | null;
}

export interface ControllerWalletAttestationCurrentInput
  extends ControllerWalletAttestationStatusInput {
  agent_id: string;
}

type ControllerWalletAttestationInput = Pick<
  ControllerWalletRow,
  "created_at" | "last_attested_at" | "reattestation_due_at"
>;

export class ControllerWalletBindingError extends Error {
  readonly code = "controller_wallet_binding_conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "ControllerWalletBindingError";
  }
}

export class ControllerWalletReattestationReplayError extends Error {
  readonly code = "controller_wallet_reattestation_replay" as const;
  constructor(message = "controller wallet re-attestation nonce already used") {
    super(message);
    this.name = "ControllerWalletReattestationReplayError";
  }
}

function stripIso(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function addSecondsIso(iso: string, seconds: number): string {
  const baseMs = Date.parse(iso);
  if (!Number.isFinite(baseMs)) return iso;
  return stripIso(new Date(baseMs + seconds * 1000));
}

function controllerReattestationDueAt(
  wallet: ControllerWalletAttestationInput,
): string {
  if (wallet.reattestation_due_at) return wallet.reattestation_due_at;
  return addSecondsIso(
    wallet.last_attested_at ?? wallet.created_at,
    DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
  );
}

export function isControllerWalletAttestationCurrent(
  db: Database.Database,
  input: ControllerWalletAttestationCurrentInput,
): boolean {
  const controller = getControllerWalletForAgent(db, input.agent_id);
  if (!controller) return false;
  return !controllerWalletAttestationStatus(controller, input)
    .reattestation_overdue;
}

export function getControllerWalletForAgent(
  db: Database.Database,
  agent_id: string,
): ControllerWalletRow | null {
  const row = db
    .prepare(
      `SELECT agent_id, account_id, wallet_address, chain_id, wallet_kind,
              provider, binding_message, binding_signature, created_at,
              last_attested_at, reattestation_due_at, last_reattestation_nonce,
              last_reattestation_message, last_reattestation_signature
       FROM agent_controller_wallets
       WHERE agent_id = ?`,
    )
    .get(agent_id) as ControllerWalletRow | undefined;
  return row ?? null;
}

export function bindControllerWallet(
  db: Database.Database,
  input: {
    account_id: string;
    agent_id: string;
    wallet_address: string;
    chain_id: string;
    wallet_kind: ControllerWalletKind;
    provider?: string | null;
    binding_message: string;
    binding_signature: string;
    createdAt: Date;
  },
): ControllerWalletRow & { idempotent_hit: boolean } {
  const txn = db.transaction(() => {
    const existing = getControllerWalletForAgent(db, input.agent_id);
    if (existing) {
      if (
        existing.account_id === input.account_id &&
        existing.wallet_address === input.wallet_address &&
        existing.chain_id === input.chain_id &&
        existing.wallet_kind === input.wallet_kind
      ) {
        return { ...existing, idempotent_hit: true };
      }
      throw new ControllerWalletBindingError(
        "agent controller wallet is already bound and cannot be transferred",
      );
    }

    const agent = db
      .prepare("SELECT wallet_address, chain_id FROM agents WHERE agent_id = ?")
      .get(input.agent_id) as
      | { wallet_address: string | null; chain_id: string | null }
      | undefined;
    if (!agent) {
      throw new ControllerWalletBindingError("agent not found");
    }
    if (
      (agent.wallet_address || agent.chain_id) &&
      (agent.wallet_address !== input.wallet_address ||
        agent.chain_id !== input.chain_id)
    ) {
      throw new ControllerWalletBindingError(
        "agent already has a different wallet binding",
      );
    }

    // Cross-account uniqueness only: one account may bind a wallet to many agents, but a
    // second account never may, or a wallet holder could attach victim accounts to it.
    const walletOwner = db
      .prepare(
        `SELECT agent_id, account_id FROM agent_controller_wallets
         WHERE wallet_address = ? AND chain_id = ?
           AND account_id != ? AND agent_id != ?
         LIMIT 1`,
      )
      .get(
        input.wallet_address,
        input.chain_id,
        input.account_id,
        input.agent_id,
      ) as { agent_id: string; account_id: string } | undefined;
    if (walletOwner) {
      throw new ControllerWalletBindingError(
        "controller wallet is already bound under a different Murmur account",
      );
    }

    const created_at = stripIso(input.createdAt);
    const nextDueAt = addSecondsIso(
      created_at,
      DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
    );
    db.prepare(
      `INSERT INTO agent_controller_wallets (
         agent_id, account_id, wallet_address, chain_id, wallet_kind,
         provider, binding_message, binding_signature, created_at,
         last_attested_at, reattestation_due_at, last_reattestation_nonce,
         last_reattestation_message, last_reattestation_signature
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      input.agent_id,
      input.account_id,
      input.wallet_address,
      input.chain_id,
      input.wallet_kind,
      input.provider ?? null,
      input.binding_message,
      input.binding_signature,
      created_at,
      created_at,
      nextDueAt,
    );
    db.prepare(
      "UPDATE agents SET wallet_address = ?, chain_id = ? WHERE agent_id = ?",
    ).run(input.wallet_address, input.chain_id, input.agent_id);
    return {
      agent_id: input.agent_id,
      account_id: input.account_id,
      wallet_address: input.wallet_address,
      chain_id: input.chain_id,
      wallet_kind: input.wallet_kind,
      provider: input.provider ?? null,
      binding_message: input.binding_message,
      binding_signature: input.binding_signature,
      created_at,
      last_attested_at: created_at,
      reattestation_due_at: nextDueAt,
      last_reattestation_nonce: null,
      last_reattestation_message: null,
      last_reattestation_signature: null,
      idempotent_hit: false,
    };
  });
  return txn();
}

export function controllerWalletAttestationStatus(
  wallet: ControllerWalletAttestationInput,
  input: ControllerWalletAttestationStatusInput,
): ControllerWalletAttestationStatus {
  const lastAttestedAt = wallet.last_attested_at ?? wallet.created_at;
  const dueAt = controllerReattestationDueAt(wallet);
  const dueMs = Date.parse(dueAt);
  const nowMs = input.checkedAt.getTime();
  return {
    last_attested_at: lastAttestedAt,
    reattestation_due_at: dueAt,
    reattestation_overdue: !Number.isFinite(dueMs) || dueMs <= nowMs,
    reattestation_interval_seconds: DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
  };
}

export function controllerWalletReattestationHealth(
  wallet: ControllerWalletAttestationInput,
  input: ControllerWalletReattestationHealthInput,
): ControllerWalletReattestationHealth {
  const attestation = controllerWalletAttestationStatus(wallet, input);
  const dueMs = Date.parse(attestation.reattestation_due_at);
  const dueSoonMs = input.dueSoonAt ? Date.parse(input.dueSoonAt) : Number.NaN;
  const reattestationDueSoon =
    !attestation.reattestation_overdue &&
    Number.isFinite(dueMs) &&
    Number.isFinite(dueSoonMs) &&
    dueMs <= dueSoonMs;
  return {
    ...attestation,
    status: attestation.reattestation_overdue
      ? "overdue"
      : reattestationDueSoon
        ? "due_soon"
        : "current",
    reattestation_due_soon: reattestationDueSoon,
  };
}

export function recordControllerWalletReattestation(
  db: Database.Database,
  input: {
    account_id: string;
    agent_id: string;
    wallet_address: string;
    chain_id: string;
    attestation_nonce: string;
    attestation_message: string;
    attestation_signature: string;
    attestedAt: Date;
    newReattestationId?: ControllerWalletReattestationIdAdapter;
  },
): ControllerWalletReattestationRow {
  const txn = db.transaction(() => {
    const controller = getControllerWalletForAgent(db, input.agent_id);
    if (
      !controller ||
      controller.account_id !== input.account_id ||
      controller.wallet_address !== input.wallet_address ||
      controller.chain_id !== input.chain_id
    ) {
      throw new ControllerWalletBindingError(
        "controller wallet binding does not match attestation request",
      );
    }
    const replay = db
      .prepare(
        `SELECT attestation_id FROM agent_controller_wallet_reattestations
         WHERE agent_id = ? AND attestation_nonce = ?
         LIMIT 1`,
      )
      .get(input.agent_id, input.attestation_nonce) as
      | { attestation_id: string }
      | undefined;
    if (replay) {
      throw new ControllerWalletReattestationReplayError();
    }
    const attestedAt = stripIso(input.attestedAt);
    const nextDueAt = addSecondsIso(
      attestedAt,
      DEFAULT_CONTROLLER_REATTESTATION_INTERVAL_SECONDS,
    );
    const attestationId = (input.newReattestationId ?? randomUUID)();
    db.prepare(
      `INSERT INTO agent_controller_wallet_reattestations (
         attestation_id, account_id, agent_id, wallet_address, chain_id,
         attestation_nonce, attestation_message, attestation_signature,
         attested_at, next_due_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attestationId,
      input.account_id,
      input.agent_id,
      input.wallet_address,
      input.chain_id,
      input.attestation_nonce,
      input.attestation_message,
      input.attestation_signature,
      attestedAt,
      nextDueAt,
    );
    db.prepare(
      `UPDATE agent_controller_wallets
       SET last_attested_at = ?,
           reattestation_due_at = ?,
           last_reattestation_nonce = ?,
           last_reattestation_message = ?,
           last_reattestation_signature = ?
       WHERE agent_id = ?`,
    ).run(
      attestedAt,
      nextDueAt,
      input.attestation_nonce,
      input.attestation_message,
      input.attestation_signature,
      input.agent_id,
    );
    return {
      attestation_id: attestationId,
      account_id: input.account_id,
      agent_id: input.agent_id,
      wallet_address: input.wallet_address,
      chain_id: input.chain_id,
      attestation_nonce: input.attestation_nonce,
      attestation_message: input.attestation_message,
      attestation_signature: input.attestation_signature,
      attested_at: attestedAt,
      next_due_at: nextDueAt,
    };
  });
  return txn();
}
