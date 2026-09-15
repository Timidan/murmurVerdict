// ─── Privy env config ──────────────────────────────────────────────────────
// Must never import `@privy-io/*`: public routes import this without pulling the SDK.

export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID?.trim() || "") as string;

export function isPrivyConfigured(): boolean {
  return PRIVY_APP_ID.length > 0;
}

export function privyAppId(): string {
  return PRIVY_APP_ID;
}
