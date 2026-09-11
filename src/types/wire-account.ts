// Shared REST wire types — account-area surface (Privy-bearer / API-key
// authed): session, agents, api-keys, controller wallet, runtime keys,
// destination address, funnel events. Browser-safe; see wire-agent.ts for
// rules. Producer guards pin these against the daemon account surfaces.

/** POST /v1/account/session. */
export interface WireAccountSession {
  account_id: string;
  created: boolean;
  privy_user_id: string;
}

/** The controller_wallet sub-object on an account agent row + the bind /
 *  reattest responses. Mirrors publicControllerWalletRow (agent-identity.ts). */
export interface WireControllerWalletSummary {
  wallet_address: string;
  chain_id: string;
  wallet_kind: "embedded" | "external";
  provider: string | null;
  created_at: string;
  last_attested_at: string;
  reattestation_due_at: string;
  reattestation_overdue: boolean;
  reattestation_interval_seconds: number;
}

/** One row of GET /v1/account/agents. */
export interface WireAccountAgent {
  agent_id: string;
  linked_at: string;
  display_slug: string | null;
  display_name: string | null;
  /** The public description. Editable at PATCH /agents/:slug/profile. */
  bio: string | null;
  kind: string | null;
  /**
   * Set once the owner retires this agent: it takes no new calls, while its
   * record, its history and its earnings stay exactly as they are.
   */
  retired_at: string | null;
  wallet_address: string | null;
  chain_id: string | null;
  controller_wallet: WireControllerWalletSummary | null;
  destination_address: string | null;
  destination_address_updated_at: string | null;
}

/** Request body for POST /v1/account/agents. */
export interface WireCreateAgentRequest {
  display_slug: string;
  display_name: string;
  bio?: string;
}

/** Response body for POST /v1/account/agents. */
export interface WireCreateAgentResponse {
  agent_id: string;
  display_slug: string;
  display_name: string;
  kind: "agent";
  created_at: string;
}

export interface WireBindWalletResponse {
  agent_id: string;
  display_slug: string;
  wallet_address: string;
  chain_id: string;
  wallet_kind: "embedded" | "external";
  provider: string | null;
  created_at: string;
  last_attested_at: string;
  reattestation_due_at: string;
  reattestation_overdue: boolean;
  reattestation_interval_seconds: number;
  idempotent_hit: boolean;
}

export interface WireControllerWalletChallengeResponse {
  agent_id: string;
  display_slug: string;
  wallet_address: string;
  chain_id: string;
  wallet_kind: "embedded" | "external";
  provider: string | null;
  authorization_issued_at: string;
  message: string;
}

export interface WireControllerWalletReattestationChallengeResponse {
  agent_id: string;
  display_slug: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  attestation_nonce: string;
  authorization_issued_at: string;
  previous_last_attested_at: string;
  previous_reattestation_due_at: string;
  reattestation_interval_seconds: number;
  message: string;
}

export interface WireControllerWalletReattestationResponse {
  agent_id: string;
  display_slug: string;
  attestation_id: string;
  controller_wallet: WireControllerWalletSummary;
}

export interface WireRuntimeKeyPolicy {
  allowed_market_ids?: string[];
  max_calls_per_hour?: number;
  max_calls_per_day?: number;
  feed_packets?: boolean;
  notes?: string;
  /** Ed25519 public key (64 lowercase hex) — presence makes the runtime key
   *  proof-of-possession: gateway requests must carry murmur-rk-v2 request
   *  signatures. Generated client-side at mint; covered by policy_hash. */
  signing_pubkey?: string;
}

export interface WireRuntimeKeyRow {
  runtime_key_id: string;
  runtime_key_prefix: string;
  label: string | null;
  policy: WireRuntimeKeyPolicy;
  policy_hash: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  last_heartbeat_at: string | null;
  connection: WireRuntimeKeyConnection;
}

export type WireRuntimeKeyConnectionStatus =
  | "never_connected"
  | "connected"
  | "stale"
  | "authorization_required";

export interface WireRuntimeKeyConnection {
  status: WireRuntimeKeyConnectionStatus;
  last_heartbeat_at: string | null;
  fresh_until: string | null;
  reason: string | null;
}

export interface WireRuntimeKeysResponse {
  keys: WireRuntimeKeyRow[];
  connection: WireRuntimeKeyConnection;
  served_at: string;
}

export interface WireRuntimeKeyChallengeResponse {
  agent_id: string;
  display_slug: string;
  controller_wallet_address: string;
  controller_chain_id: string;
  policy_hash: string;
  authorization_nonce: string;
  authorization_issued_at: string;
  expires_at: string | null;
  message: string;
}

export interface WireRuntimeKeyMintResponse {
  runtime_key_id: string;
  secret: string;
  runtime_key_prefix: string;
  label: string | null;
  policy_hash: string;
  created_at: string;
  expires_at: string | null;
  warning?: string;
}

/**
 * Response body for POST /v1/account/agents/:slug/api-keys. `secret` is the
 * ONE place this plaintext is ever returned by the API.
 */
export interface WireMintApiKeyResponse {
  api_key_id: string;
  secret: string;
  created_at: string;
  warning?: string;
}

/** One row of GET /v1/account/agents/:slug/api-keys (metadata only). */
export interface WireApiKeyRow {
  api_key_id: string;
  created_at: string;
  label?: string | null;
  rotated_at?: string | null;
}

/** Response body for DELETE /v1/account/api-keys/:key_id. */
export interface WireRotateApiKeyResponse {
  rotated: boolean;
}

/** Response body for PATCH /v1/account/agents/:slug/destination-address. */
export interface WirePatchDestinationResponse {
  agent_id: string;
  destination_address: string;
  destination_address_updated_at: string;
}

/** 429 body for the destination PATCH when the §7.4 cooldown is active. */
export interface WireDestinationCooldownError {
  error: string;
  code: string;
  // Optional to match the daemon type (`number | undefined`); the form parses
  // it defensively with a `typeof … === "number"` guard.
  retry_after_seconds?: number;
}

/**
 * Allowlisted funnel-event kinds. Mirrors the server-side
 * FunnelEventKindSchema (src/verdict/account-funnel-surface.ts).
 */
export type WireFunnelEventKind =
  | "landing.viewed"
  | "compete.clicked"
  | "privy.modal_opened"
  | "privy.signed_in"
  | "agent.created"
  | "api_key.minted"
  | "destination.set"
  | "call.first_submitted"
  | "call.first_resolved"
  | "call.tenth_submitted";

/** One row from the admin sender board (GET /v1/refs) / public /v1/refs/top. */
export interface WireAdminRefSender {
  ref: string;
  total: number;
  agents_touched: number;
  converted: number;
  last_at: string;
}
