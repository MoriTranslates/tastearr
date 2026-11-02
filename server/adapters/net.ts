import dns from "node:dns/promises";
import net from "node:net";
import { blockedHost, checkOutbound, OutboundError } from "../core/outbound.js";

/**
 * Outbound requests to user-configured addresses (Sonarr, Radarr, Plex, Jellyfin, ntfy, Gotify, Discord).
 *
 * `checkOutbound` (core) only sees the URL text. Here the hostname is also resolved and every address it resolves to
 * is checked, so a name pointing at 169.254.169.254 (or fe80::, fd00:ec2::254) is refused like the literal address.
 * Private LAN, loopback and Docker addresses stay allowed: that is where Sonarr, Radarr and Plex live.
 *
 * Redirects are followed by hand. `fetch` would otherwise follow them itself and resend custom headers such as
 * X-Api-Key and X-Plex-Token to wherever the server points (only Authorization is dropped on a cross-origin redirect).
 * A redirect is followed only to the same host (an http -> https upgrade, a moved path), re-checked each time.
 *
 * Not covered: DNS rebinding between this lookup and fetch's own lookup. Closing that needs a custom connection
 * lookup, which Node's built-in fetch doesn't expose without the separate undici package. An attacker would need a
 * logged-in session to save the address and control of its DNS, and the target would still have to be link-local.
 */

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

/**
 * Test seam. Under `npm test` (TASTEARR_TEST) names resolve to a documentation address (TEST-NET-3) instead of
 * querying real DNS, like un-mocked fetches fail there; tests that check resolution replace `lookup`.
 */
export const resolver: { lookup: Lookup } = {
  lookup: process.env.TASTEARR_TEST
    ? async () => [{ address: "203.0.113.10", family: 4 }]
    : (host) => dns.lookup(host, { all: true, verbatim: true }),
};

/** checkOutbound plus: the hostname's resolved addresses must not be link-local / cloud metadata either. */
export async function resolveOutbound(url: string, what = "That address"): Promise<URL> {
  checkOutbound(url, what);
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return u;
  let addrs: { address: string }[];
  try {
    addrs = await resolver.lookup(host);
  } catch (e) {
    throw new Error(`${what}: can't find the host "${host}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, { cause: e });
  }
  const bad = addrs.find((a) => blockedHost(a.address));
  if (bad) throw new OutboundError(`${what} isn't allowed: "${host}" points to ${bad.address} (link-local / cloud metadata address)`);
  return u;
}

const MAX_REDIRECTS = 3;

/** `fetch` to a user-configured address: resolved and checked first, redirects only to the same host. */
export async function safeFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  let target = await resolveOutbound(url, what);
  const host = target.hostname;
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    const next = new URL(loc, target);
    if (hop >= MAX_REDIRECTS) throw new Error(`${what} redirects too many times; enter the final address in Settings`);
    if (next.hostname !== host)
      throw new Error(`${what} redirects to ${next.origin}. Enter that address in Settings instead (keys are not forwarded).`);
    // Browsers turn a POST/PUT into a GET on 301/302/303. Doing that here would silently skip the write (and read a
    // list as if it were the reply), so only 307/308, which keep the method and body, are followed for writes.
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && res.status !== 307 && res.status !== 308)
      throw new Error(`${what} redirects to ${next.href}. Enter the final address in Settings.`);
    target = await resolveOutbound(next.href, what);
  }
}
