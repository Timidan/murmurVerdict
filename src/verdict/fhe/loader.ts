/**
 * Boot-time loader for the FHE provider. The daemon constructs ONE
 * provider per process and passes it through `SubmissionContext`. The
 * provider type comes from `MURMUR_FHE_PROVIDER`:
 *
 *   - unset / "zama_local" → ZamaLocalFheProvider (real TFHE-rs sidecar over
 *                            Unix-domain socket; requires the Rust binary
 *                            at tools/fhe-sidecar/ running on the host)
 *   - "mock"               → MockFheProvider (explicit offline CI/dev opt-in;
 *                            in-process JSON pseudo-encryption, not private)
 *
 * Demand-evidence retreat: /v2/calls currently refuses privacy_mode=fhe_direct
 * because there's no terminal score-release path until a real ≥9-org holder
 * committee + decrypt path land together. While that holds, the FHE provider's
 * only live role is exposing `active_keyset_id` on /v1/readyz + /v1/meta so
 * agents can discover the keyset for future use. The provider continues to
 * load on boot regardless of mode so the surface stays stable when the
 * threshold path is restored.
 *
 * Unknown values fall back to `mock` with a `console.warn` rather than
 * crashing boot — the daemon should keep serving legacy_plaintext traffic
 * even if the operator typos the env var.
 */
import type Database from "better-sqlite3";
import type { FheProvider } from "./provider.js";
import { MockFheProvider } from "./mock-provider.js";
import { ZamaLocalFheProvider } from "./zama-local-provider.js";

export type FheProviderEnv = "mock" | "zama_local";

// Wave 2a — FHE is mandatory. The previous MURMUR_FHE_DIRECT_ENABLED
// gate is gone; the loader now constructs a provider unconditionally
// at boot. Operators select the backend via MURMUR_FHE_PROVIDER
// ('zama_local' default for the sidecar IPC; 'mock' explicit for offline CI;
// v0.3 adds 'zama_kms' for the real committee). isFheDirectEnabled is
// retained for back-compat callers that just want "yes, FHE is on" — it now
// always returns true.
export function isFheDirectEnabled(): boolean {
  return true;
}

export function loadFheProviderFromEnv(
  db: Database.Database,
): FheProvider | null {
  const raw = (process.env.MURMUR_FHE_PROVIDER ?? "zama_local").trim().toLowerCase();
  let kind: FheProviderEnv;
  if (raw === "mock" || raw === "zama_local") {
    kind = raw;
  } else {
    console.warn(
      `[daemon] unknown MURMUR_FHE_PROVIDER='${raw}'; falling back to 'mock'`,
    );
    kind = "mock";
  }
  switch (kind) {
    case "mock":
      return new MockFheProvider({ db });
    case "zama_local":
      return new ZamaLocalFheProvider({ db });
  }
}
