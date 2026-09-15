import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { keccak256, toHex } from "viem";

import { canonicalHash, canonicalize } from "../receipts/canonical.js";
import type { AccountAgentIdAdapter } from "./account-agent-surface.js";
import {
  bindControllerWallet,
  getAccountForAgent,
  getControllerWalletForAgent,
  getOrCreateAccount,
  linkAgentToAccount,
  mintRuntimeKey,
  type AccountIdAdapter,
  type RuntimeKeyMintAdapters,
} from "./auth/accounts.js";
import { agentsRepo, marketsRepo } from "./db.js";
import {
  AgentProfileSchema,
  WalletAddressSchema,
} from "./schema.js";
import { nowIso } from "./time.js";

export const OPERATOR_BLIND_FIXTURE_CHAIN_ID = 84532;
export const OPERATOR_BLIND_FIXTURE_CHAIN_CAIP =
  `eip155:${OPERATOR_BLIND_FIXTURE_CHAIN_ID}`;
export const OPERATOR_BLIND_FIXTURE_SLUG = "operator-blind-test";
/**
 * Fixture generation; bump via env for a fresh market, since on-chain registration is one-shot
 * and the fixture schedule expires. The seeder prints the market id for OPERATOR_BLIND_MARKET_ID.
 */
export const OPERATOR_BLIND_FIXTURE_GENERATION =
  process.env.OPERATOR_BLIND_FIXTURE_GENERATION?.trim() || "v1";
export const OPERATOR_BLIND_FIXTURE_MARKET_ID = keccak256(
  toHex(`murmur:operator-blind-test:market:${OPERATOR_BLIND_FIXTURE_GENERATION}`),
).toLowerCase();
export const OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS = 90;
export const OPERATOR_BLIND_FIXTURE_PRIVY_USER_ID =
  "did:fixture:operator-blind-test";
// An external venue market like every real one (polymarket-gamma, event_binary, multinomial_brier).
// Its endDate + embargoSec must match the on-chain registration. The gate never calls resolution or Gamma.
export const OPERATOR_BLIND_FIXTURE_MARKET_REF = {
  protocol: "polymarket-gamma",
  sourceId: OPERATOR_BLIND_FIXTURE_MARKET_ID,
  configVersion: 1,
} as const;
export const OPERATOR_BLIND_FIXTURE_MARKET_OUTCOMES = ["YES", "NO"] as const;

export type OperatorBlindFixtureRuntimeAuthorizationNonceAdapter = () => string;
export type OperatorBlindFixtureRuntimeAuthorizationMessageIdAdapter =
  () => string;

export interface OperatorBlindFixtureSeedInput extends RuntimeKeyMintAdapters {
  db: Database.Database;
  agentWallet: string;
  /** On-chain reveal schedule. `endDateMs + embargoSec*1000` must equal the contract's publicRevealAt or acceptance refuses. */
  revealSchedule: { endDateMs: number; embargoSec: number };
  now: () => Date;
  newAccountId?: AccountIdAdapter;
  newAgentId?: AccountAgentIdAdapter;
  newRuntimeAuthorizationNonce?: OperatorBlindFixtureRuntimeAuthorizationNonceAdapter;
  newRuntimeAuthorizationMessageId?: OperatorBlindFixtureRuntimeAuthorizationMessageIdAdapter;
}

export interface OperatorBlindFixtureSeedResult {
  slug: string;
  agent_address: string;
  chain_id: number;
  market_id: string;
  market_ref: typeof OPERATOR_BLIND_FIXTURE_MARKET_REF;
  created_account: boolean;
  created_agent: boolean;
  linked_agent: boolean;
  bound_wallet: boolean;
  account_id: string;
  agent_id: string;
  runtime_key_id: string;
  runtime_key_secret: string;
  runtime_key_prefix: string;
}

export function seedOperatorBlindFixtureDb(
  input: OperatorBlindFixtureSeedInput,
): OperatorBlindFixtureSeedResult {
  const agentWallet = WalletAddressSchema.parse(input.agentWallet);
  const seededAt = input.now();

  return input.db.transaction(() => {
    const seededAtIso = nowIso(seededAt);
    let agent = agentsRepo.bySlug(input.db, OPERATOR_BLIND_FIXTURE_SLUG);
    let accountId = agent ? getAccountForAgent(input.db, agent.agent_id) : null;
    let createdAccount = false;
    let createdAgent = false;
    let linkedAgent = false;
    let boundWallet = false;

    if (!accountId) {
      const account = getOrCreateAccount(
        input.db,
        {
          privy_user_id: OPERATOR_BLIND_FIXTURE_PRIVY_USER_ID,
          session_id: "operator-blind-fixture",
          expires_at: seededAtIso,
          primary_login_method: "fixture",
        },
        {
          resolvedAt: seededAt,
          newAccountId: input.newAccountId,
        },
      );
      accountId = account.account_id;
      createdAccount = account.created;
    }

    if (!agent) {
      const agentId = (input.newAgentId ?? randomUUID)();
      const profile = AgentProfileSchema.parse({
        agent_id: agentId,
        display_slug: OPERATOR_BLIND_FIXTURE_SLUG,
        kind: "agent",
        display_name: "Operator Blind Test",
        bio: "Local release-gate fixture for the operator-blind FHE round-trip.",
        created_at: seededAtIso,
        wallet_address: agentWallet,
        chain_id: OPERATOR_BLIND_FIXTURE_CHAIN_CAIP,
      });
      agentsRepo.insert(input.db, profile);
      agent = agentsRepo.byId(input.db, agentId);
      if (!agent) throw new Error("failed to create fixture agent");
      createdAgent = true;
    }

    const owner = getAccountForAgent(input.db, agent.agent_id);
    if (!owner) {
      linkAgentToAccount(input.db, accountId, agent.agent_id, {
        linkedAt: seededAt,
      });
      linkedAgent = true;
    } else if (owner !== accountId) {
      throw new Error(`agent ${agent.agent_id} is already linked to account ${owner}`);
    }

    const existingWallet = getControllerWalletForAgent(input.db, agent.agent_id);
    if (!existingWallet) {
      bindControllerWallet(input.db, {
        account_id: accountId,
        agent_id: agent.agent_id,
        wallet_address: agentWallet,
        chain_id: OPERATOR_BLIND_FIXTURE_CHAIN_CAIP,
        wallet_kind: "external",
        provider: "operator-blind-fixture",
        binding_message: "operator-blind fixture controller wallet binding",
        binding_signature: "0x" + "11".repeat(65),
        createdAt: seededAt,
      });
      boundWallet = true;
    } else if (
      existingWallet.wallet_address !== agentWallet ||
      existingWallet.chain_id !== OPERATOR_BLIND_FIXTURE_CHAIN_CAIP
    ) {
      throw new Error(
        `existing controller wallet ${existingWallet.wallet_address}/${existingWallet.chain_id} does not match ${agentWallet}/${OPERATOR_BLIND_FIXTURE_CHAIN_CAIP}`,
      );
    }

    // Retire pending calls from earlier generations: fixture markets never resolve, so each run
    // holds a slot against the per-agent active limit. Scoped to this agent and fixture-flagged markets.
    const retired = input.db
      .prepare(
        `UPDATE submissions
            SET status = 'rejected'
          WHERE agent_id = @agent_id
            AND status = 'pending_t1'
            AND market_id IN (
              SELECT market_id FROM markets
               WHERE json_extract(config_json, '$.fixture') = 1
            )`,
      )
      .run({ agent_id: agent.agent_id });
    if (retired.changes > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[operator-blind-fixture] retired ${retired.changes} pending call(s) from ` +
          `earlier fixture generations so this agent has free slots`,
      );
    }

    marketsRepo.upsertExternalMarket(input.db, {
      market_id: OPERATOR_BLIND_FIXTURE_MARKET_ID,
      asset_id: "polymarket:event",
      market_kind: "event_binary",
      horizon_seconds: OPERATOR_BLIND_FIXTURE_MARKET_HORIZON_SECONDS,
      primary_oracle_id: "polymarket-gamma-oracle",
      adapter_id: OPERATOR_BLIND_FIXTURE_MARKET_REF.protocol,
      market_family: "prediction-market-binary",
      scoring_kind: "multinomial_brier",
      // Satisfies the polymarket-gamma marketConfigSchema the external-market guard parses at submit.
      config_json: JSON.stringify({
        conditionId: OPERATOR_BLIND_FIXTURE_MARKET_ID,
        slug: OPERATOR_BLIND_FIXTURE_SLUG,
        outcomes: [...OPERATOR_BLIND_FIXTURE_MARKET_OUTCOMES],
        endDate: new Date(input.revealSchedule.endDateMs).toISOString(),
        embargoSec: input.revealSchedule.embargoSec,
        gamma_url: `https://polymarket.com/event/${OPERATOR_BLIND_FIXTURE_SLUG}`,
        label: OPERATOR_BLIND_FIXTURE_SLUG,
        fixture: true,
      }),
      void_band: "0",
      status: "listed",
      created_at: seededAtIso,
    });

    const policy = {
      allowed_intents: ["sealed_call"],
      allowed_chain_ids: [OPERATOR_BLIND_FIXTURE_CHAIN_ID],
      allowed_market_ids: [OPERATOR_BLIND_FIXTURE_MARKET_ID],
      max_calls_per_hour: 1000,
      max_calls_per_day: 10000,
      notes: "operator-blind gateway release-gate fixture",
    };
    const runtimeAuthorizationMessageId =
      (input.newRuntimeAuthorizationMessageId ?? randomUUID)();
    const runtimeKey = mintRuntimeKey(input.db, {
      account_id: accountId,
      agent_id: agent.agent_id,
      label: `operator-blind ${seededAtIso}`,
      policy_json: canonicalize(policy),
      policy_hash: canonicalHash(policy),
      controller_wallet_address: agentWallet,
      controller_chain_id: OPERATOR_BLIND_FIXTURE_CHAIN_CAIP,
      authorization_nonce:
        (input.newRuntimeAuthorizationNonce ?? randomUUID)(),
      authorization_message:
        `operator-blind runtime key ${runtimeAuthorizationMessageId}`,
      authorization_signature: "0x" + "12".repeat(65),
      createdAt: seededAt,
      newRuntimeKeyId: input.newRuntimeKeyId,
      newRuntimeKeySecret: input.newRuntimeKeySecret,
    });

    return {
      slug: OPERATOR_BLIND_FIXTURE_SLUG,
      agent_address: agentWallet,
      chain_id: OPERATOR_BLIND_FIXTURE_CHAIN_ID,
      market_id: OPERATOR_BLIND_FIXTURE_MARKET_ID,
      market_ref: OPERATOR_BLIND_FIXTURE_MARKET_REF,
      created_account: createdAccount,
      created_agent: createdAgent,
      linked_agent: linkedAgent,
      bound_wallet: boundWallet,
      account_id: accountId,
      agent_id: agent.agent_id,
      runtime_key_id: runtimeKey.runtime_key_id,
      runtime_key_secret: runtimeKey.secret,
      runtime_key_prefix: runtimeKey.runtime_key_prefix,
    };
  })();
}
