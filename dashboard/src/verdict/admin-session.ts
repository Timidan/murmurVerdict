// Operator admin-token browser session, shared by every admin console.
// Sent to the daemon as the `X-Admin-Token` header; never put it in a URL.
// Session storage: the token ends with the tab instead of persisting.

const TOKEN_KEY = "murmur-verdict.admin-token.v1";

/** Read the session admin token, or "" when unset / storage unavailable. */
export function readAdminToken(): string {
  if (typeof window === "undefined") return "";
  try {
    // Earlier builds kept the token in localStorage indefinitely.
    window.localStorage.removeItem(TOKEN_KEY);
    return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Store (or, with a falsy value, remove) the admin token. Silent on failure. */
export function writeAdminToken(token: string): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage disabled / quota — silent fail
  }
}

export function clearAdminToken(): void {
  writeAdminToken("");
}
