import crypto from "node:crypto";
import net from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getSettings } from "./settings.js";

export const COOKIE = "tastearr_session";
const TTL_MS = 30 * 86_400_000;

function sign(payload: string) {
  return crypto.createHmac("sha256", getSettings().secret).update(payload).digest("base64url");
}

export function makeSession(username: string) {
  const payload = `${Buffer.from(username).toString("base64url")}.${Date.now() + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

function validSession(token: string | undefined) {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const [user, exp] = payload.split(".");
  return Number(exp) > Date.now() && Buffer.from(user, "base64url").toString() === getSettings().auth.username;
}

export function isLocal(ip: string) {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::1" || /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

export function authState(req: FastifyRequest) {
  const a = getSettings().auth;
  const required = a.enabled && !!a.passwordHash;
  if (!required) return { required: false, ok: true };
  if (a.bypassLocal && isLocal(req.ip)) return { required: true, ok: true, local: true };
  const key = (req.headers["x-api-key"] as string | undefined) ?? (req.query as Record<string, string | undefined>).apikey;
  if (key && key === getSettings().apiKey) return { required: true, ok: true };
  return { required: true, ok: validSession(req.cookies[COOKIE]) };
}

/** onRequest hook: everything under /api needs auth except status/login and the webhook (which checks its key itself). */
export async function guard(req: FastifyRequest, reply: FastifyReply) {
  const url = req.url.split("?")[0];
  if (!url.startsWith("/api/") || url === "/api/status" || url === "/api/auth/login") return;
  if (url.startsWith("/api/webhook/")) {
    const key = (req.query as Record<string, string | undefined>).apikey ?? req.headers["x-api-key"];
    if (key !== getSettings().apiKey) return reply.code(401).send({ error: "Bad or missing apikey" });
    return;
  }
  if (!authState(req).ok) return reply.code(401).send({ error: "Login required" });
}
