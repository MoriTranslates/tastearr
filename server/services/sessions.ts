import crypto from "node:crypto";
import { safeEqual } from "../core/secrets.js";
import { isRevoked, revoke } from "../data/sessions.js";
import { getSettings } from "./settings.js";

/** Signed session cookies and signed one-action links, both keyed by the settings' signing secret. */

export const SESSION_TTL_MS = 30 * 86_400_000;

const hmac = (data: string) => crypto.createHmac("sha256", getSettings().secret).update(data).digest("base64url");

export function makeSession(username: string) {
  // The random part makes every login's cookie unique, so logging out one device doesn't revoke another's.
  const payload = `${Buffer.from(username).toString("base64url")}.${Date.now() + SESSION_TTL_MS}.${crypto.randomBytes(9).toString("base64url")}`;
  return `${payload}.${hmac(`session:${payload}`)}`;
}

const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function validSession(token: string | undefined) {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), hmac(`session:${payload}`))) return false;
  const [user, exp] = payload.split(".");
  if (!(Number(exp) > Date.now() && Buffer.from(user, "base64url").toString() === getSettings().auth.username)) return false;
  return !isRevoked(tokenHash(token));
}

/** Logout: the cookie stops working on the server too, not just in this browser (a copied cookie can't be reused). */
export function revokeSession(token: string | undefined) {
  if (!token || !validSession(token)) return false;
  const exp = Number(token.slice(0, token.lastIndexOf(".")).split(".")[1]);
  revoke(tokenHash(token), exp);
  return true;
}

/** Signed, expiring link for one action on one show (used by phone alert buttons). */
export function signAction(action: string, id: number, ttlMs = 14 * 86_400_000) {
  const exp = Date.now() + ttlMs;
  return { exp, sig: hmac(`action:${action}:${id}:${exp}`) };
}

export function verifyAction(action: string, id: number, exp: number, sig: string) {
  return exp > Date.now() && safeEqual(sig, hmac(`action:${action}:${id}:${exp}`));
}
