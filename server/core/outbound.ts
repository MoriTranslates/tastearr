import net from "node:net";

/**
 * Addresses Tastearr must never send requests (and API keys) to: link-local (169.254/16, where cloud metadata services
 * live, and fe80::/10), "this network" 0/8, the unspecified address, and the known metadata hostnames/IPv6 endpoints.
 * LAN addresses (10/8, 172.16/12, 192.168/16, loopback, Docker names) stay allowed: Sonarr, Radarr and Plex live there.
 */
const blocked = new net.BlockList();
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("100.100.100.200", 32, "ipv4"); // Alibaba Cloud metadata
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("fd00:ec2::", 32, "ipv6"); // AWS IPv6 metadata (fd00:ec2::254)
blocked.addAddress("::", "ipv6");

const BLOCKED_NAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** An IPv4 address hidden inside an IPv6 one: ::ffff:a.b.c.d (mapped, also written as hex), ::a.b.c.d, 64:ff9b::/96 (NAT64). */
function embeddedV4(ip6: string): string | null {
  const m = ip6.match(/^(?:::ffff:|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function blockedHost(hostname: string) {
  const h = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (BLOCKED_NAMES.has(h)) return true;
  if (net.isIPv4(h)) return blocked.check(h, "ipv4");
  if (net.isIPv6(h)) {
    const v4 = embeddedV4(h);
    return v4 ? blocked.check(v4, "ipv4") : blocked.check(h, "ipv6");
  }
  return false;
}

export class OutboundError extends Error {
  statusCode = 400;
}

/**
 * Checks an address Tastearr will call (Sonarr, Radarr, Plex/Jellyfin, ntfy, Gotify, Discord): http(s) only and never
 * a link-local / cloud-metadata address. `what` names the setting in the error. Returns the URL unchanged.
 */
export function checkOutbound(url: string, what = "That address") {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OutboundError(`${what} isn't a valid URL (it should start with http://)`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new OutboundError(`${what} must start with http:// or https://`);
  if (blockedHost(u.hostname)) throw new OutboundError(`${what} isn't allowed (link-local / cloud metadata address)`);
  return url;
}
