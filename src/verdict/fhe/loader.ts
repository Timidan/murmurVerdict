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

export function isFheDirectEnabled(): boolean {
  return process.env.MURMUR_FHE_DIRECT_ENABLED === "1";
}

export function loadFheProviderFromEnv(
  db: Database.Database,
): FheProvider | null {
  if (!isFheDirectEnabled()) {
    // Hard contract: when the flag is off, the daemon must behave
    // byte-identically to today's master. We do not even instantiate
    // a provider, so no DB rows get touched.
    return null;
  }
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
