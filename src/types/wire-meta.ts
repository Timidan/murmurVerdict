// Shared REST wire types — GET /v1/meta. Browser-safe; see wire-agent.ts for
// rules. Mirrors the public fields of the daemon's publicMetaSurface(...)
// return (src/verdict/public-system-surface.ts). The daemon also emits a
// `paid_inference` block the dashboard does not consume; the producer guard
// checks the daemon output CONFORMS to this contract, so the extra block does
// not need mirroring here.

export interface WireMetaResponse {
  schema_version: number;
  scoring_version: number;
  strategy_tags: readonly string[];
  assets: string[];
  verified_volume_24h: { count: number; since_iso: string };
  privacy?: {
    // The daemon widens this to `string` (object-literal inference), so the
    // wire contract does too — see wire-contract-guards.ts.
    mode: string;
    threshold_network: string;
    pending_verdicts_private: boolean;
    public_reveal_after_horizon: boolean;
    /** True when the gateway accepts plaintext verdicts and seals them
     *  server-side (MURMUR_OWNED_SEALING_ENABLED). An integrator deciding
     *  whether to trust the seal needs this stated, not inferred. */
    plaintext_submission_path: boolean;
    /** Operator blindness, in the agent card's vocabulary. Distinct from
     *  `pending_verdicts_private`, which is about PUBLIC visibility: a
     *  verdict can be non-public and still readable by the operator. */
    operator_holds_plaintext: string;
  };
  /** Present when the daemon has a Fhenix chain configured. */
  fhenix?: {
    chain_id: string;
    chain_id_numeric: number;
    contract_address: string | null;
  };
}
