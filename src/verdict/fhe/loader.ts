/**
 * Boot-time loader for the FHE provider. The daemon constructs ONE
 * provider per process and passes it through `SubmissionContext`. The
 * provider type comes from `MURMUR_FHE_PROVIDER`:
 *
 *   - unset / "mock"      → MockFheProvider (default; CI + dev)
 *   - "zama_local"        → ZamaLocalFheProvider (stub until Z2)
 *
 * Unknown values fall back to `mock` with a `console.warn` rather than
 * crashing boot — the daemon should keep serving legacy_plaintext /
 * committed traffic even if the operator typos the env var. Submissions
 * with `privacy_mode=fhe_direct` still get rejected with
 * `z1_not_implemented` until Z1 lands the submission path.
 */
import type Database from "better-sqlite3";
import type { FheProvider } from "./provider.js";
import { MockFheProvider } from "./mock-provider.js";
import { ZamaLocalFheProvider } from "./zama-local-provider.js";

export type FheProviderEnv = "mock" | "zama_local";

// Wave 2a — FHE is mandatory. The previous MURMUR_FHE_DIRECT_ENABLED
// gate is gone; the loader now constructs a provider unconditionally
// at boot. Operators select the backend via MURMUR_FHE_PROVIDER
// ('mock' default for dev; 'zama_local' for the sidecar IPC; v0.3
// adds 'zama_kms' for the real committee). isFheDirectEnabled is
// retained for back-compat callers that just want "yes, FHE is on" —
// it now always returns true.
export function isFheDirectEnabled(): boolean {
  return true;
}

export function loadFheProviderFromEnv(
  db: Database.Database,
): FheProvider | null {
  const raw = (process.env.MURMUR_FHE_PROVIDER ?? "mock").trim().toLowerCase();
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
