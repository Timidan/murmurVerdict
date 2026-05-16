// Mock-mode detection. URL ?mock=1 enables, ?mock=0 disables; choice
// persists to localStorage["murmur.mock"]. Read once at module load so
// the conditional exports in api.ts / useStream.ts have a stable answer
// for the lifetime of the page. Flipping ?mock at runtime requires a
// reload — no React context, no re-render coupling.

const STORAGE_KEY = "murmur.mock";

function resolve(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = new URL(window.location.href);
    const param = url.searchParams.get("mock");
    if (param === "1") {
      try {
        localStorage.setItem(STORAGE_KEY, "1");
      } catch {
        // localStorage unavailable (private mode, quota). Still honour the
        // URL param this session.
      }
      return true;
    }
    if (param === "0") {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // No-op on storage failure — the URL param wins for this load.
      }
      return false;
    }
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export const MOCK_MODE = resolve();
