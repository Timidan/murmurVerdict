export const DEFAULT_LOCAL_PUBLIC_ORIGIN = "http://localhost:8080";

export interface MurmurPublicOrigin {
  publicApiUrl: string | null;
  dashboardUrl: string | null;
}

export class MurmurPublicOriginConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "MurmurPublicOriginConfigError";
    this.key = key;
  }
}

export function loadMurmurPublicOrigin(
  env: NodeJS.ProcessEnv = process.env,
): MurmurPublicOrigin {
  const publicApiUrl = normalizeConfiguredUrl(
    env.MURMUR_PUBLIC_URL,
    "MURMUR_PUBLIC_URL",
  );
  return {
    publicApiUrl,
    dashboardUrl:
      normalizeConfiguredUrl(env.MURMUR_DASHBOARD_URL, "MURMUR_DASHBOARD_URL") ??
      publicApiUrl,
  };
}

/**
 * Never derives from the request: a Host-header fallback let an attacker
 * poison cached /embed.js and OG URLs (audit F-12). Unset config now yields
 * the documented localhost default — wrong-but-honest links that tell the
 * operator to set MURMUR_PUBLIC_URL, instead of reflecting attacker input.
 */
export function publicApiUrlForRequest(
  origin: MurmurPublicOrigin,
): string {
  return publicApiBaseUrl(origin);
}

export function publicApiBaseUrl(
  origin: MurmurPublicOrigin,
): string {
  return origin.publicApiUrl ?? DEFAULT_LOCAL_PUBLIC_ORIGIN;
}

export function dashboardBaseUrl(
  origin: MurmurPublicOrigin,
): string {
  return origin.dashboardUrl ?? "";
}

export function dashboardWebOrigin(
  origin: MurmurPublicOrigin,
): string {
  const raw = origin.dashboardUrl;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function normalizeConfiguredUrl(
  raw: string | undefined,
  key: string,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return trimmed.replace(/\/+$/, "");
    }
  } catch {
    // Re-throw below with a stable config error shape.
  }
  throw new MurmurPublicOriginConfigError(
    key,
    "must be an absolute http or https URL",
  );
}
