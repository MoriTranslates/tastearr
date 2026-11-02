import net from "node:net";

/** IP and host classification for the home-network rules. */

const v4 = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

/** Any private, loopback or link-local address (used to tell a real LAN proxy from a forged header). */
export function isPrivateIp(ip: string) {
  const a4 = v4(ip);
  if (net.isIPv4(a4)) {
    const [a, b] = a4.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

export function inCidr(ip: string, cidr: string) {
  const [base, bits] = cidr.split("/");
  const a = v4(ip);
  if (!net.isIPv4(a) || !net.isIPv4(base)) return false;
  const n = (x: string) => x.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const len = bits === undefined ? 32 : Number(bits);
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return (n(a) & mask) === (n(base) & mask);
}

/**
 * The home network: 10/8, 192.168/16 and IPv6 ULA/link-local by default, or exactly the given IPv4 CIDRs. 172.16/12
 * (Docker's own networks) and loopback never count by default: see http/auth.ts.
 */
export function isHomeNetwork(ip: string, custom: string[] = []) {
  if (custom.length) return custom.some((c) => inCidr(ip, c));
  const a = v4(ip);
  if (net.isIPv4(a)) return inCidr(a, "10.0.0.0/8") || inCidr(a, "192.168.0.0/16");
  return /^f[cd]/i.test(ip) || /^fe[89ab][0-9a-f]:/i.test(ip);
}

/** The socket peer is loopback: then it is a proxy or tunnel on the same host, not the user's device. */
export const isLoopback = (peer: string) => v4(peer).startsWith("127.") || peer === "::1";

/** A LAN address: private IPv4, loopback, a single-label Docker/mDNS name or *.local. */
export function isPrivateHost(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) && /^[\d.]+$/.test(h)) return true;
  if (h === "localhost" || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return /^[a-z0-9-]+$/.test(h) || h.endsWith(".local");
}
