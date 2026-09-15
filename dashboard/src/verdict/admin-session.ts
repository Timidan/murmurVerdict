// Operator admin-token browser session, shared by every admin console.
// Sent to the daemon as the `X-Admin-Token` header; never put it in a URL.

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

export function clearAdminToken(): void {
  writeAdminToken("");
}
