// Single owner of the operator admin-token browser session.
//
// Every admin console (gateway, overview, refs) reads and writes the operator
// token through THIS module — the storage key and the read/write/clear logic
// live in exactly one place, so a token unlocked on one console carries over to
// the others and there is no per-page copy to drift.
//
// The token is handed to `verdictApi` admin methods as their first positional
// argument; those methods send it to the daemon as the `X-Admin-Token` header.
// It never enters a request URL.

const TOKEN_KEY = "murmur-verdict.admin-token.v1";

/** Read the persisted admin token, or "" when unset / storage unavailable. */
export function readAdminToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Persist (or, with a falsy value, remove) the admin token. Silent on failure. */
export function writeAdminToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage disabled / quota — silent fail
  }
}

/** Clear the persisted admin token (sign-out). */
export function clearAdminToken(): void {
  writeAdminToken("");
}
