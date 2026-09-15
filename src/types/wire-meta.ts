// Shared REST wire types: GET /v1/meta. Browser-safe; see wire-agent.ts.
// The daemon's output only has to conform, so unconsumed blocks are not mirrored.

export interface WireMetaResponse {
  schema_version: number;
  scoring_version: number;
  strategy_tags: readonly string[];
  assets: string[];
  verified_volume_24h: { count: number; since_iso: string };
  privacy?: {
    // `string` because the daemon's inferred type widens it.
    mode: string;
    threshold_network: string;
    pending_verdicts_private: boolean;
    public_reveal_after_horizon: boolean;
    /** True when the gateway accepts plaintext verdicts and seals them server-side. */
    plaintext_submission_path: boolean;
    /** Operator blindness. Unlike `pending_verdicts_private` (public visibility), a
     *  non-public verdict can still be readable by the operator. */
    operator_holds_plaintext: string;
  };
  /** Present when the daemon has a Fhenix chain configured. */
  fhenix?: {
    chain_id: string;
    chain_id_numeric: number;
    contract_address: string | null;
    relayer_address: string | null;
  };
}
