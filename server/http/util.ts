import type { FastifyReply, FastifyRequest } from "fastify";
import { fail, parseId } from "../core/errors.js";
import { checkOutbound } from "../core/outbound.js";
import { isMasked } from "../core/settings.js";
import { SEASONS, seasonOf } from "../core/taste/media.js";
import { makeSession, SESSION_TTL_MS } from "../services/sessions.js";
import { COOKIE } from "./auth.js";

/** Request parsing helpers shared by the route modules. */

export { fail };

export const parseSeason = (q: Record<string, string | undefined>) => {
  const cur = seasonOf();
  const wanted = q.season?.toUpperCase();
  const season = wanted === undefined ? cur.season : SEASONS.find((x) => x === wanted);
  const year = Number(q.year) || cur.year;
  if (!season || year < 1960 || year > 2100) throw fail("Bad season");
  return { season, year };
};

/** A positive integer id from a path or body. */
export const id = parseId;

export const monitorChoice = (v: unknown) => (["season", "all", "future", "none"] as const).find((x) => x === v);

/** A boolean from the body, or undefined (= use the setting) for anything else. */
export const optionalBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

/** A stored secret is only re-used for the URL it was saved with, so it can't be sent somewhere new. */
export function withSecret(url: unknown, secret: unknown, storedUrl: string, storedSecret: string) {
  const u = checkOutbound(
    String(url ?? "")
      .trim()
      .replace(/\/+$/, ""),
  );
  const s = String(secret ?? "");
  if (s && !isMasked(s)) return { url: u, secret: s };
  if (u === storedUrl && storedSecret) return { url: u, secret: storedSecret };
  throw fail("Enter the API key/token again for a new address");
}

export function sessionCookie(req: FastifyRequest, reply: FastifyReply, username: string) {
  reply.setCookie(COOKIE, makeSession(username), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: req.protocol === "https",
    maxAge: SESSION_TTL_MS / 1000,
  });
}
