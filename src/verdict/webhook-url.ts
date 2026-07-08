import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type WebhookUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export interface WebhookUrlPolicy {
  allowHttp: boolean;
}

export type WebhookDnsLookupAddress = {
  address: string;
  family: number;
};

export type WebhookDnsLookup = (
  hostname: string,
) => Promise<WebhookDnsLookupAddress[]>;

export interface WebhookUrlValidationDeps {
  dnsLookup?: WebhookDnsLookup;
}

export class WebhookUrlPolicyConfigError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(`${key}: ${message}`);
    this.name = "WebhookUrlPolicyConfigError";
    this.key = key;
  }
}

export function loadWebhookUrlPolicy(
  env: NodeJS.ProcessEnv = process.env,
): WebhookUrlPolicy {
  return {
    allowHttp: booleanEnv(env.WEBHOOK_ALLOW_HTTP, false, "WEBHOOK_ALLOW_HTTP"),
  };
}

/**
 * Reject webhook URLs that could be turned into an SSRF/port-scan primitive
 * once the daemon runs on a public host: non-public schemes, userinfo, and
 * hostnames that resolve to loopback / link-local / private / reserved IPs.
 *
 * Hostname is resolved via dns.lookup at registration time; the returned
 * canonical URL is what we persist, so subsequent deliveries fetch the same
 * string we validated. (TOCTOU re-resolution on delivery is left for a
 * follow-up — the dispatcher already has a 5s timeout cap.)
 */
export async function validateWebhookUrl(
  raw: string,
  policy: WebhookUrlPolicy,
  deps: WebhookUrlValidationDeps = {},
): Promise<WebhookUrlValidation> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "url must be a valid absolute URL" };
  }
  if (
    parsed.protocol !== "https:" &&
    !(policy.allowHttp && parsed.protocol === "http:")
  ) {
    return { ok: false, reason: "url must use https://" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "url must not contain userinfo" };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, reason: "url must have a hostname" };
  // Block obvious internal names regardless of what they resolve to.
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal")) {
    return { ok: false, reason: "internal hostname not allowed" };
  }
  // If the host is an IP literal, validate directly. Otherwise resolve.
  const literal = isIP(host);
  let addresses: WebhookDnsLookupAddress[] = [];
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await (deps.dnsLookup ?? nodeWebhookDnsLookup)(host);
    } catch {
      return { ok: false, reason: "hostname did not resolve" };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: "hostname did not resolve" };
    }
  }
  for (const a of addresses) {
    if (isPrivateOrReservedIp(a.address)) {
      return { ok: false, reason: "hostname resolves to a private/reserved address" };
    }
  }
  return { ok: true, url: parsed.toString() };
}

const nodeWebhookDnsLookup: WebhookDnsLookup = async (hostname) => {
  return dnsLookup(hostname, { all: true });
};

/**
 * True if the address is loopback, link-local, RFC1918, CGNAT, broadcast,
 * multicast, unspecified, IPv6 unique-local, or the cloud-metadata IP.
 */
function isPrivateOrReservedIp(address: string): boolean {
  // Cloud metadata: AWS / GCP / Azure / DigitalOcean all use this.
  if (address === "169.254.169.254") return true;

  if (isIP(address) === 4) {
    const parts = address.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true; // malformed -> treat as private/reserved
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast (224.0.0.0/4) + reserved (240.0.0.0/4)
    return false;
  }

  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified, loopback
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6: ::ffff:a.b.c.d -> re-check the embedded v4 address.
    const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
    if (mapped && isIP(mapped[1]) === 4) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }

  return true; // unknown family -> fail closed
}

function booleanEnv(
  raw: string | undefined,
  fallback: boolean,
  key: string,
): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new WebhookUrlPolicyConfigError(
    key,
    "must be one of true, false, 1, 0, yes, or no",
  );
}
