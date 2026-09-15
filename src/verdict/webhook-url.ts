import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type WebhookUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export type WebhookDestinationValidation =
  | { ok: true; url: string; address: string; family: 4 | 6 }
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
 * Registration validates the current address set. Delivery repeats this
 * resolution and pins the validated address into the socket lookup, closing
 * the DNS-rebinding gap between policy validation and connection setup.
 */
export async function validateWebhookUrl(
  raw: string,
  policy: WebhookUrlPolicy,
  deps: WebhookUrlValidationDeps = {},
): Promise<WebhookUrlValidation> {
  const result = await resolveWebhookDestination(raw, policy, deps);
  return result.ok
    ? { ok: true, url: result.url }
    : result;
}

/**
 * Resolve a webhook URL to one public address suitable for a pinned socket
 * connection. Every returned DNS address must be public; mixed public/private
 * answers fail closed rather than allowing resolver-order tricks.
 */
export async function resolveWebhookDestination(
  raw: string,
  policy: WebhookUrlPolicy,
  deps: WebhookUrlValidationDeps = {},
): Promise<WebhookDestinationValidation> {
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
  let destination: { address: string; family: 4 | 6 } | null = null;
  for (const a of addresses) {
    const family = isIP(a.address);
    if ((family !== 4 && family !== 6) || isPrivateOrReservedIp(a.address)) {
      return { ok: false, reason: "hostname resolves to a private/reserved address" };
    }
    destination ??= { address: a.address, family };
  }
  if (!destination) {
    return { ok: false, reason: "hostname did not resolve" };
  }
  return {
    ok: true,
    url: parsed.toString(),
    address: destination.address,
    family: destination.family,
  };
}

const nodeWebhookDnsLookup: WebhookDnsLookup = async (hostname) => {
  return dnsLookup(hostname, { all: true });
};

/**
 * Blocked ranges: loopback, link-local (incl. cloud metadata), private, CGNAT,
 * multicast, unspecified, documentation, and IPv6 unique-local/transition.
 */
const reservedWebhookIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  reservedWebhookIpv4.addSubnet(network, prefix, "ipv4");
}
const reservedWebhookIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  reservedWebhookIpv6.addSubnet(network, prefix, "ipv6");
}

function isPrivateOrReservedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return reservedWebhookIpv4.check(address, "ipv4");
  if (family === 6) return reservedWebhookIpv6.check(address, "ipv6");
  return true;
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
