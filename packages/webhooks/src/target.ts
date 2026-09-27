import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Webhook URLs are customer-supplied and requested from inside the VPC, so
// without this a webhook could point at internal services or the instance
// metadata endpoint (169.254.169.254) and have the worker fetch it.
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 — can reach any IPv4 address, internal ones included
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export class WebhookTargetError extends Error {}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) reaches the IPv4 host, so judge
    // it by the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all — never connect to it
}

export interface TargetPolicy {
  // Local development only: lets a webhook point at localhost receivers.
  allowPrivate: boolean;
  requireHttps: boolean;
}

export function targetPolicyFromEnv(env = process.env): TargetPolicy {
  const production = env.NODE_ENV === "production";
  return {
    allowPrivate: !production && env.WEBHOOK_ALLOW_PRIVATE_TARGETS === "true",
    requireHttps: production,
  };
}

// Static checks that need no DNS: usable both when a webhook is registered
// and again right before each delivery.
export function validateWebhookUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookTargetError("url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookTargetError("url must be an http(s) URL");
  }
  if (policy.requireHttps && url.protocol !== "https:") {
    throw new WebhookTargetError("url must use https");
  }
  if (url.username || url.password) {
    throw new WebhookTargetError("url must not embed credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!policy.allowPrivate) {
    if (isIP(host) && isBlockedAddress(host)) {
      throw new WebhookTargetError("url points at a private or reserved address");
    }
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      throw new WebhookTargetError("url points at an internal hostname");
    }
  }
  return url;
}

// A `lookup` for http(s).request that refuses to connect when the hostname
// resolves to a blocked address. Checking the address actually connected
// to (rather than resolving once up front and connecting later) is what
// defeats DNS rebinding.
export function guardedLookup(policy: TargetPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      const allowed = policy.allowPrivate ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (list.length === 0 || allowed.length !== list.length) {
        // Refuse outright if *any* record is internal, rather than picking
        // a public one: a mixed answer is itself a sign of rebinding.
        return callback(
          new WebhookTargetError(`${hostname} resolves to a private or reserved address`) as NodeJS.ErrnoException,
          "",
          0,
        );
      }
      if (options.all) return callback(null, allowed as never);
      callback(null, allowed[0].address, allowed[0].family);
    });
  };
}
