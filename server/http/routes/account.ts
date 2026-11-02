import type { FastifyInstance } from "fastify";
import type { Status } from "../../../shared/api.js";
import { VERSION } from "../../config.js";
import { safeEqual } from "../../core/secrets.js";
import { signedInStatus } from "../../services/health.js";
import { revokeSession } from "../../services/sessions.js";
import { getSettings, patchSettings, setAccount, setBypassLocal } from "../../services/settings.js";
import {
  authState,
  checkLoginSize,
  checkPasswordLimited,
  COOKIE,
  csrfOk,
  hostAllowed,
  isLocalRequest,
  loginAllowed,
  loginSucceeded,
  SETUP_TOKEN,
} from "../auth.js";
import { fail, sessionCookie } from "../util.js";

/** Login, setup and account bodies are a few short strings: no need to parse the app-wide 1 MB. */
const AUTH_BODY_LIMIT = 8_192;

/** Status, first-run setup, login/logout and account changes. */
export function accountRoutes(app: FastifyInstance) {
  app.get("/api/status", { config: { setup: true } }, async (req): Promise<Status> => {
    const a = authState(req);
    const base = { version: VERSION, setupRequired: a.setupRequired, loggedIn: a.ok };
    if (!a.ok) return base;
    return { ...base, via: a.via ?? undefined, ...signedInStatus() };
  });

  let settingUp = false;
  app.post<{ Body: { username?: string; password?: string; bypassLocal?: boolean; setupToken?: string } }>(
    "/api/auth/setup",
    { config: { setup: true }, bodyLimit: AUTH_BODY_LIMIT },
    async (req, reply) => {
      if (getSettings().auth.passwordHash || settingUp) throw fail("Account already exists", 409);
      if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
      // A fresh install can only be claimed from the local network, or with the token printed in the container log.
      const local = isLocalRequest(req) && hostAllowed(req);
      if (!local && !safeEqual(String(req.body?.setupToken ?? ""), SETUP_TOKEN))
        throw fail("Open Tastearr from your home network to create the account, or enter the setup code from the container log", 403);
      const username = String(req.body?.username ?? "").trim();
      const password = String(req.body?.password ?? "");
      checkLoginSize(username, password);
      if (!username || password.length < 8) throw fail("Choose a username and a password of at least 8 characters");
      settingUp = true;
      try {
        await setAccount(username, password);
        patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: req.body?.bypassLocal === true } }));
      } finally {
        settingUp = false;
      }
      sessionCookie(req, reply, username);
      return { ok: true };
    },
  );

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    { config: { setup: true }, bodyLimit: AUTH_BODY_LIMIT },
    async (req, reply) => {
      if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
      // (A proxy without TRUST_PROXY is noticed for every request in the guard: proxyWithoutTrust.)
      const username = String(req.body?.username ?? "");
      const password = String(req.body?.password ?? "");
      checkLoginSize(username, password);
      if (!loginAllowed(req.ip, username)) throw fail("Too many attempts, wait a few seconds and try again", 429);
      const a = getSettings().auth;
      const okUser = safeEqual(username, a.username);
      // The account's own name checks in its reserved slot, so a flood of other names can't refuse it.
      const okPass = await checkPasswordLimited(password, a.passwordHash || "00:00", okUser);
      if (!okUser || !okPass) throw fail("Wrong username or password", 401);
      loginSucceeded(req.ip, a.username);
      sessionCookie(req, reply, a.username);
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    revokeSession(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.put<{ Body: { currentPassword?: string; username?: string; password?: string } }>(
    "/api/auth/account",
    { bodyLimit: AUTH_BODY_LIMIT },
    async (req, reply) => {
      const a = getSettings().auth;
      const current = String(req.body?.currentPassword ?? "");
      const username = String(req.body?.username ?? a.username).trim() || a.username;
      const password = String(req.body?.password ?? "");
      checkLoginSize(username, current);
      checkLoginSize(username, password);
      // Same throttle as login: a stolen session cookie shouldn't allow unlimited password guesses.
      if (!loginAllowed(req.ip, a.username)) throw fail("Too many attempts, wait a few seconds and try again", 429);
      if (!(await checkPasswordLimited(current, a.passwordHash, true))) throw fail("Current password is wrong", 403);
      loginSucceeded(req.ip, a.username);
      if (password && password.length < 8) throw fail("New password must be at least 8 characters");
      if (password) await setAccount(username, password);
      else patchSettings((s) => ({ ...s, auth: { ...s.auth, username } }));
      sessionCookie(req, reply, username); // changing the password rotated the signing secret
      return { ok: true };
    },
  );

  /** "Authentication required" mode. Needs a real login session, so a bypassed LAN device can't turn the bypass on. */
  app.put<{ Body: { bypassLocal?: boolean } }>("/api/auth/mode", async (req) => {
    if (authState(req).via !== "session") throw fail("Log in with your password to change this", 403);
    setBypassLocal(req.body?.bypassLocal === true);
    return { ok: true, bypassLocal: req.body?.bypassLocal === true };
  });
}
