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

/**
 * An address as a number and its width in bits: IPv4 (IPv4-mapped IPv6 included) is 32, IPv6 128. Null when it isn't
 * an IP address. A zone index (fe80::1%eth0) is ignored.
 */
function toBits(ip: string): { n: bigint; width: number } | null {
  const a = v4(ip.replace(/%.*$/, ""));
  if (net.isIPv4(a)) return { n: BigInt(a.split(".").reduce((acc, o) => acc * 256 + Number(o), 0)), width: 32 };
  if (!net.isIPv6(a)) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4 was handled above; others like 64:ff9b::1.2.3.4) becomes two hex groups.
  const s = a.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, p, q, r, t) =>
    [(Number(p) << 8) | Number(q), (Number(r) << 8) | Number(t)].map((x) => x.toString(16)).join(":"),
  );
  const [head, tail] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  return { n: groups.reduce((acc, g) => (acc << BigInt(16)) | BigInt(parseInt(g, 16)), BigInt(0)), width: 128 };
}

/**
 * `ip` is inside `cidr` ("10.0.0.0/8", "fd12:3456::/32", or a bare address meaning that address only). Strict: the
 * prefix must be plain digits within the family's width, so a malformed entry ("/33", "/", "/abc") matches nothing
 * instead of a huge range. IPv4 and IPv6 never match each other (IPv4-mapped IPv6 counts as IPv4).
 */
export function inCidr(ip: string, cidr: string) {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(cidr.trim());
  if (!m) return false;
  const a = toBits(ip);
  const base = toBits(m[1]);
  if (!a || !base || a.width !== base.width) return false;
  const prefix = m[2] === undefined ? base.width : Number(m[2]);
  if (prefix > base.width) return false;
  const shift = BigInt(base.width - prefix);
  return a.n >> shift === base.n >> shift;
}

/** A TASTEARR_LOCAL_NETWORKS / TRUST_PROXY entry that inCidr can use (anything else matches nothing). */
export const validCidr = (cidr: string) => inCidr(cidr.trim().split("/")[0], cidr);

/**
 * The home network: 10/8, 192.168/16 and IPv6 link-local (fe80::/10) by default, or exactly the given CIDRs (IPv4
 * or IPv6, so a home LAN on IPv6 ULA can opt in).
 * Docker's own networks never count: 172.16/12 for IPv4, and IPv6 ULA (fc00::/7), which Docker's IPv6 bridges use (an
 * internet request through docker-proxy can arrive from the bridge gateway, e.g. fd00::1). Loopback doesn't either.
 * http/auth.ts also refuses 172.16/12 and loopback peers when TASTEARR_LOCAL_NETWORKS lists them.
 */
export function isHomeNetwork(ip: string, custom: string[] = []) {
  if (custom.length) return custom.some((c) => inCidr(ip, c));
  const a = v4(ip);
  if (net.isIPv4(a)) return inCidr(a, "10.0.0.0/8") || inCidr(a, "192.168.0.0/16");
  return /^fe[89ab][0-9a-f]:/i.test(ip);
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
