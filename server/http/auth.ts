import crypto from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail } from "../core/errors.js";
import { inCidr, isHomeNetwork as inHomeNetwork, isLoopback, isPrivateIp } from "../core/network.js";
import { checkPassword, safeEqual } from "../core/secrets.js";
import { noteProxy } from "../services/health.js";
import { validDevice, validSession } from "../services/sessions.js";
import { getSettings } from "../services/settings.js";

/**
 * Who is asking: the API key, a session cookie, or (opt-in) a device on the home network. Also the request guard
 * every /api route passes, CSRF and DNS-rebinding checks, the login throttle and the first-run setup code.
 */

export const COOKIE = "tastearr_session";
/** Marks a browser that has logged in before (services/sessions.ts makeDevice). */
export const DEVICE_COOKIE = "tastearr_device";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route checks its own credentials (webhooks, signed action links). */
    public?: boolean;
    /** Reachable before an account exists. */
    setup?: boolean;
  }
}

/** TRUST_PROXY: a hop count or a comma-separated list of proxy IPs/CIDRs. "true" is refused (it trusts any X-Forwarded-For). */
let warnedTrue = false;
export function trustProxyOption(): number | string[] | false {
  const v = (process.env.TRUST_PROXY ?? "").trim();
  if (!v || v === "false") return false;
  if (v === "true") {
    if (!warnedTrue)
      console.warn(
        "TRUST_PROXY=true is not allowed (anyone could fake their IP). Use a hop count or your proxy's IP/CIDR, e.g. TRUST_PROXY=172.18.0.0/16",
      );
    warnedTrue = true;
    return false;
  }
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}
/** At startup; isLocalRequest re-reads the variable so tests can change it. */
export const PROXY_TRUSTED = trustProxyOption() !== false;

const FORWARD_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-client-ip",
  "via",
];

/**
 * "Disabled for local addresses": the device itself must be on the home network and talking to us directly.
 * - Any forwarding header means a proxy or tunnel relayed the request, whatever TRUST_PROXY says (with a proxy list
 *   set, a LAN relay that isn't on the list used to be judged by the address it was relaying for).
 * - The socket peer is judged, never `req.ip` (which TRUST_PROXY may take from a header).
 * - A listed proxy, a hop-count TRUST_PROXY (it trusts whatever is in front blindly), Docker's 172.16/12 and loopback
 *   never get the bypass, even when TASTEARR_LOCAL_NETWORKS lists those ranges.
 */
export function isLocalRequest(req: FastifyRequest) {
  if (FORWARD_HEADERS.some((h) => req.headers[h])) return false;
  if (typeof trustProxyOption() === "number") return false;
  const peer = req.socket?.remoteAddress ?? "";
  const v4peer = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  if (inCidr(v4peer, "172.16.0.0/12")) return false;
  return isHomeNetwork(v4peer) && !isProxyPeer(peer);
}

/**
 * The home network, for the "disabled for local addresses" bypass and for claiming a fresh install: 10/8, 192.168/16
 * and IPv6 link-local by default. Not Docker's own networks (172.16/12; IPv6 ULA, used by Docker's IPv6 bridges): its
 * NAT gateway or docker-proxy can make internet requests arrive from 172.17.0.1 or fd00::1. Not loopback (a tunnel or
 * proxy on the same host). TASTEARR_LOCAL_NETWORKS (comma-separated IPv4 CIDRs) replaces the defaults, but
 * isLocalRequest still refuses 172.16/12 and loopback peers (see localNetworkWarnings).
 */
export function isHomeNetwork(ip: string) {
  return inHomeNetwork(ip, customNetworks());
}

const customNetworks = () =>
  (process.env.TASTEARR_LOCAL_NETWORKS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Startup warnings: TASTEARR_LOCAL_NETWORKS entries overlapping Docker's 172.16/12 or loopback, which the bypass
 * ignores whatever the variable says. A home LAN that really uses 172.16/12 would otherwise lose the bypass silently.
 */
export function localNetworkWarnings(): string[] {
  const never = ["172.16.0.0/12", "127.0.0.0/8"];
  const overlaps = (c: string) => {
    const base = c.split("/")[0];
    return never.some((n) => inCidr(base, n) || inCidr(n.split("/")[0], c));
  };
  const ignored = customNetworks().filter(overlaps);
  if (!ignored.length) return [];
  return [
    `TASTEARR_LOCAL_NETWORKS lists ${ignored.join(", ")}, but addresses in 172.16.0.0/12 (Docker's own networks) and 127.0.0.0/8 (loopback) never count as local: logins from there always need the password.`,
  ];
}

/** The socket peer is a loopback or a trusted proxy: then it isn't the user's device. */
function isProxyPeer(peer: string) {
  if (isLoopback(peer)) return true;
  const p = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  const t = trustProxyOption();
  return Array.isArray(t) && t.some((c) => (c.includes("/") ? inCidr(p, c) : c === p || c === peer));
}

/**
 * Guards against DNS rebinding: a local bypass only counts when the browser addressed us by IP or a LAN name.
 * The public externalUrl deliberately does NOT qualify: requests for it usually came through a proxy.
 */
export function hostAllowed(req: FastifyRequest) {
  const host = (req.headers.host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!host) return false;
  if (
    net.isIP(host) ||
    host === "localhost" ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".home.arpa")
  )
    return true;
  return (process.env.TASTEARR_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(host);
}

/** Blocks cross-site form posts: state-changing browser requests must carry our header and a same-origin Origin. */
export function csrfOk(req: FastifyRequest) {
  if (req.method === "GET" || req.method === "HEAD") return true;
  if (req.headers["x-tastearr"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function authState(req: FastifyRequest) {
  const a = getSettings().auth;
  const setupRequired = !a.passwordHash;
  if (setupRequired) return { setupRequired, ok: false, via: null };
  if (safeEqual(req.headers["x-api-key"] as string | undefined, getSettings().apiKey))
    return { setupRequired, ok: true, via: "apikey" as const };
  if (validSession(req.cookies[COOKIE])) return { setupRequired, ok: true, via: "session" as const };
  if (a.bypassLocal && isLocalRequest(req) && hostAllowed(req)) return { setupRequired, ok: true, via: "local" as const };
  return { setupRequired, ok: false, via: null };
}

/** onRequest hook. Decides on the matched route pattern, never the raw URL, and denies /api by default. */
export async function guard(req: FastifyRequest, reply: FastifyReply) {
  if (proxyWithoutTrust(req)) noteProxy();
  const route = req.routeOptions.url;
  if (!route || !route.startsWith("/api/")) return; // static files / SPA fallback
  const cfg = req.routeOptions.config ?? {};
  if (cfg.public) return;
  if (cfg.setup) return; // status, login and first-run setup check their own preconditions
  const st = authState(req);
  if (st.setupRequired) return reply.code(401).send({ error: "Create an account first", setupRequired: true });
  if (!st.ok) return reply.code(401).send({ error: "Login required" });
  if (st.via !== "apikey" && !csrfOk(req)) return reply.code(403).send({ error: "Cross-site request blocked" });
}

/**
 * Login limits. Usernames and passwords longer than this are refused before the throttle or scrypt see them (each
 * throttle entry is kept for 30 minutes, so an uncapped username let one request pin up to the 1 MB body limit).
 * `perUser` free tries per throttle entry. One IP gets its own entry for up to `namesPerIp` user names; further names
 * from it share one entry, so rotating names neither resets the throttle nor grows the table. `maxTracked` caps the
 * table; `scryptSlots` password checks run at once and `scryptQueue` more may wait.
 */
export const LOGIN_LIMITS = {
  maxUser: 128,
  maxPassword: 1024,
  perUser: 5,
  namesPerIp: 10,
  maxTracked: 10_000,
  scryptSlots: 2,
  scryptQueue: 16,
};

/** Refuses an over-long username or password (400) before anything expensive runs. */
export function checkLoginSize(username: string, password: string) {
  if (username.length > LOGIN_LIMITS.maxUser) throw fail(`Usernames are at most ${LOGIN_LIMITS.maxUser} characters`);
  if (password.length > LOGIN_LIMITS.maxPassword) throw fail(`Passwords are at most ${LOGIN_LIMITS.maxPassword} characters`);
}

// In-memory login throttle, with growing back-off instead of a hard lock-out. Behind a proxy without TRUST_PROXY every
// client shares one address, so nothing here may let junk logins from that address refuse the owner:
// - "u:" entries are per IP + user name; one IP gets at most `namesPerIp` of them.
// - Further names from that IP share its "s:" entry, which backs off like a single name.
// - The account's own user name always keeps its own entry, so only guessing *that* name slows the owner down.
// Trade-off: while an address floods made-up names, the real name answers 401 where junk names get 429, which can
// reveal the user name to that flooder. The password is still needed, and guessing it is throttled on its own entry.
type Attempt = { n: number; until: number; seen: number; ip: string };
const attempts = new Map<string, Attempt>();
/** Own ("u:") entries per IP. */
const namesOf = new Map<string, number>();
const STALE_MS = 30 * 60_000;
let prunedAt = 0;
const userKey = (ip: string, user: string) => `u:${ip}|${user.toLowerCase()}`;
const sharedKey = (ip: string) => `s:${ip}`;

function drop(key: string) {
  const a = attempts.get(key);
  if (!a) return;
  attempts.delete(key);
  if (!key.startsWith("u:")) return;
  const n = (namesOf.get(a.ip) ?? 1) - 1;
  if (n > 0) namesOf.set(a.ip, n);
  else namesOf.delete(a.ip);
}

function prune(now: number) {
  if (now - prunedAt > 60_000) {
    prunedAt = now;
    for (const [k, v] of attempts) if (now - v.seen > STALE_MS) drop(k);
  }
  // Oldest first (entries are re-inserted on every attempt): a flood of new addresses can't grow the table without
  // bound. Room is left for the entry this attempt may add.
  for (const k of attempts.keys()) {
    if (attempts.size + 1 <= LOGIN_LIMITS.maxTracked) break;
    drop(k);
  }
}

// A browser that logged in before (a valid device cookie) is throttled on its own entry, kept apart from the per-address
// table: neither a flood naming the real user nor a full table can slow it down. Device ids are only ever issued by a
// successful login, so this table can't be flooded; it is still capped.
const deviceAttempts = new Map<string, Attempt>();
const MAX_DEVICES = 1_000;

/**
 * Whether this login attempt may go ahead now. `device` is the id from a valid device cookie (see deviceOf), if any.
 */
export function loginAllowed(ip: string, user: string, device: string | null = null) {
  const now = Date.now();
  prune(now);
  if (device) {
    const d = deviceAttempts.get(device) ?? { n: 0, until: 0, seen: now, ip };
    if (d.until > now) return false;
    d.n++;
    d.seen = now;
    if (d.n > LOGIN_LIMITS.perUser) d.until = now + Math.min(15_000, 1000 * 2 ** (d.n - LOGIN_LIMITS.perUser));
    deviceAttempts.delete(device);
    deviceAttempts.set(device, d);
    for (const k of deviceAttempts.keys()) {
      if (deviceAttempts.size <= MAX_DEVICES) break;
      deviceAttempts.delete(k);
    }
    return true;
  }
  const own = user.toLowerCase() === getSettings().auth.username.toLowerCase();
  let key = userKey(ip, user);
  if (!own && !attempts.has(key) && (namesOf.get(ip) ?? 0) >= LOGIN_LIMITS.namesPerIp) key = sharedKey(ip);
  let a = attempts.get(key);
  if (!a) {
    a = { n: 0, until: 0, seen: now, ip };
    if (key.startsWith("u:")) namesOf.set(ip, (namesOf.get(ip) ?? 0) + 1);
  }
  if (a.until > now) return false;
  // 5 free tries, then 2s, 4s, 8s ... capped at 15s. Password hashing (scrypt) is the real brake on guessing; a long
  // lock would let anyone who knows the username keep the owner out (behind a proxy everyone shares one IP).
  a.n++;
  a.seen = now;
  if (a.n > LOGIN_LIMITS.perUser) a.until = now + Math.min(15_000, 1000 * 2 ** (a.n - LOGIN_LIMITS.perUser));
  attempts.delete(key);
  attempts.set(key, a);
  return true;
}
export function loginSucceeded(ip: string, user: string, device: string | null = null) {
  drop(userKey(ip, user));
  if (device) deviceAttempts.delete(device);
}

/** The device id from the request's device cookie, when it is valid. */
export const deviceOf = (req: FastifyRequest) => validDevice(req.cookies[DEVICE_COOKIE]);

/** Login throttle entries (tests: the table stays bounded). */
export const trackedLoginAttempts = () => attempts.size;

// scrypt is deliberately slow; unbounded parallel checks would let a burst of requests tie up every CPU. Three lanes,
// each with its own slots and queue limit:
// - "shared": every other request.
// - "owner": requests naming the account's own user name, so a flood of junk names can't refuse them. The name is
//   guessable, so a flood naming it can fill this lane (AnimeArr review B4).
// - "device": a browser that logged in before (a valid device cookie) or an already signed-in session; a flood without
//   that cookie can't reach this lane.
type Lane = "shared" | "owner" | "device";
const lanes: Record<Lane, { active: number; waiting: (() => void)[] }> = {
  shared: { active: 0, waiting: [] },
  owner: { active: 0, waiting: [] },
  device: { active: 0, waiting: [] },
};

/**
 * checkPassword with at most `scryptSlots` running at once in the shared lane (one in the others) and `scryptQueue`
 * waiting per lane; more are refused with 429.
 */
export async function checkPasswordLimited(pw: string, stored: string, laneName: Lane = "shared") {
  const lane = lanes[laneName];
  const slots = laneName === "shared" ? LOGIN_LIMITS.scryptSlots : 1;
  if (lane.active < slots) lane.active++;
  else {
    if (lane.waiting.length >= LOGIN_LIMITS.scryptQueue)
      throw fail("Too many login attempts at once, wait a few seconds and try again", 429);
    await new Promise<void>((r) => lane.waiting.push(r)); // the finishing check hands its slot over
  }
  try {
    return await checkPassword(pw, stored);
  } finally {
    const next = lane.waiting.shift();
    if (next) next();
    else lane.active--;
  }
}

/**
 * A request came through a proxy (forwarding headers from a LAN peer) while TRUST_PROXY isn't set: every client then
 * looks like the proxy's address, so the login throttle and the logs see one client. Logged once per process and shown
 * as a banner (`noteProxy`).
 */
let proxyLogged = false;
export function proxyWithoutTrust(req: FastifyRequest) {
  if (PROXY_TRUSTED || !(req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) return false;
  const peer = req.socket?.remoteAddress ?? "";
  if (!isPrivateIp(peer)) return false; // a forged header straight from the internet proves nothing
  if (!proxyLogged) {
    proxyLogged = true;
    console.warn(
      `Requests are arriving through a proxy at ${peer}, but TRUST_PROXY isn't set: every client looks like one address (${peer}), so login throttling is shared by all of them. Set TRUST_PROXY to the proxy's IP address.`,
    );
  }
  return true;
}

/** One-time token for claiming a fresh install from outside the local network; printed to the container log. */
export const SETUP_TOKEN = crypto.randomBytes(6).toString("hex");
