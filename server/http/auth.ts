import crypto from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail } from "../core/errors.js";
import { inCidr, isHomeNetwork as inHomeNetwork, isLoopback } from "../core/network.js";
import { checkPassword, safeEqual } from "../core/secrets.js";
import { validSession } from "../services/sessions.js";
import { getSettings } from "../services/settings.js";

/**
 * Who is asking: the API key, a session cookie, or (opt-in) a device on the home network. Also the request guard
 * every /api route passes, CSRF and DNS-rebinding checks, the login throttle and the first-run setup code.
 */

export const COOKIE = "tastearr_session";

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
 * and IPv6 ULA/link-local by default. 172.16/12 (Docker's own networks: Docker's NAT gateway or docker-proxy, e.g. for
 * IPv6 or Docker Desktop, would make internet requests arrive from 172.17.0.1) and loopback (a tunnel or proxy on the
 * same host) are not in the defaults. TASTEARR_LOCAL_NETWORKS (comma-separated IPv4 CIDRs) replaces the defaults, but
 * isLocalRequest still refuses 172.16/12 and loopback peers.
 */
export function isHomeNetwork(ip: string) {
  const custom = (process.env.TASTEARR_LOCAL_NETWORKS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return inHomeNetwork(ip, custom);
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
 * `perUser` free tries per IP + username and `perIp` per IP whatever the username (changing the name no longer resets
 * the throttle); `maxTracked` caps the table; `scryptSlots` password checks run at once, `scryptQueue` more may wait.
 */
export const LOGIN_LIMITS = { maxUser: 128, maxPassword: 1024, perUser: 5, perIp: 20, maxTracked: 10_000, scryptSlots: 2, scryptQueue: 16 };

/** Refuses an over-long username or password (400) before anything expensive runs. */
export function checkLoginSize(username: string, password: string) {
  if (username.length > LOGIN_LIMITS.maxUser) throw fail(`Usernames are at most ${LOGIN_LIMITS.maxUser} characters`);
  if (password.length > LOGIN_LIMITS.maxPassword) throw fail(`Passwords are at most ${LOGIN_LIMITS.maxPassword} characters`);
}

// In-memory login throttle per IP + username and per IP, with growing back-off instead of a hard lock-out.
type Attempt = { n: number; until: number; seen: number };
const attempts = new Map<string, Attempt>();
const STALE_MS = 30 * 60_000;
let prunedAt = 0;

function prune(now: number) {
  if (now - prunedAt > 60_000) {
    prunedAt = now;
    for (const [k, v] of attempts) if (now - v.seen > STALE_MS) attempts.delete(k);
  }
  // Oldest first (entries are re-inserted on every attempt): a flood of new keys can't grow the table without bound.
  // Room is left for the two keys one attempt adds.
  for (const k of attempts.keys()) {
    if (attempts.size + 2 <= LOGIN_LIMITS.maxTracked) break;
    attempts.delete(k);
  }
}

/** Counts one attempt on `key`; past `free` tries the next one waits 2s, 4s, 8s ... capped at 15s. */
function count(key: string, free: number, now: number) {
  const a = attempts.get(key) ?? { n: 0, until: 0, seen: now };
  a.n++;
  a.seen = now;
  if (a.n > free) a.until = now + Math.min(15_000, 1000 * 2 ** (a.n - free));
  attempts.delete(key);
  attempts.set(key, a);
}

export function loginAllowed(ip: string, user: string) {
  const now = Date.now();
  prune(now);
  const userKey = `${ip}|${user.toLowerCase()}`;
  const ipKey = `${ip}|*`;
  if ((attempts.get(userKey)?.until ?? 0) > now || (attempts.get(ipKey)?.until ?? 0) > now) return false;
  // Password hashing (scrypt) is the real brake on guessing; a long lock would let anyone who knows the username keep
  // the owner out (behind a proxy everyone shares one IP), so both throttles only slow down.
  count(userKey, LOGIN_LIMITS.perUser, now);
  count(ipKey, LOGIN_LIMITS.perIp, now);
  return true;
}
export function loginSucceeded(ip: string, user: string) {
  attempts.delete(`${ip}|${user.toLowerCase()}`);
  attempts.delete(`${ip}|*`);
}

/** Login throttle entries (tests: the table stays bounded). */
export const trackedLoginAttempts = () => attempts.size;

// scrypt is deliberately slow; unbounded parallel checks would let a burst of requests tie up every CPU.
let scryptActive = 0;
const scryptWaiting: (() => void)[] = [];

/** checkPassword with at most `scryptSlots` running at once; a full queue is refused (429) instead of growing. */
export async function checkPasswordLimited(pw: string, stored: string) {
  if (scryptActive < LOGIN_LIMITS.scryptSlots) scryptActive++;
  else {
    if (scryptWaiting.length >= LOGIN_LIMITS.scryptQueue)
      throw fail("Too many login attempts at once, wait a few seconds and try again", 429);
    await new Promise<void>((r) => scryptWaiting.push(r)); // the finishing check hands its slot over
  }
  try {
    return await checkPassword(pw, stored);
  } finally {
    const next = scryptWaiting.shift();
    if (next) next();
    else scryptActive--;
  }
}

/** One-time token for claiming a fresh install from outside the local network; printed to the container log. */
export const SETUP_TOKEN = crypto.randomBytes(6).toString("hex");
