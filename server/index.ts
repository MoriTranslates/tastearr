import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { getMediaByIds, seasonOf, shiftSeason, SEASONS, type Season } from "./anilist.js";
import { authState, COOKIE, csrfOk, guard, loginAllowed, loginSucceeded, makeSession, trustProxyOption, verifyAction } from "./auth.js";
import { listJobs, setJob } from "./db.js";
import { discover, useDiscovered } from "./discover.js";
import { announceAired, follow, followedIds, followedShows, unfollow } from "./following.js";
import { refreshLists } from "./lists.js";
import { mapAnilist, mappingTables } from "./mapping.js";
import { listJellyfinUsers, listLibraries, plexCheckPin, plexCreatePin, plexServers, testMediaServer } from "./mediaserver.js";
import { notifySeason, send } from "./notify.js";
import { getQuiz } from "./quiz.js";
import { addMovie, radarrOptions, testRadarr } from "./radarr.js";
import { checkPassword, getSettings, isMasked, patchSettings, publicSettings, regenerateKey, safeEqual, setAccount, setGenrePrefs, updateSettings, type Settings } from "./settings.js";
import { dropShow, handleRadarrWebhook, handleSonarrWebhook, myShows, undropShow } from "./shows.js";
import { addSeries, monitorSeason, sonarrOptions, testSonarr } from "./sonarr.js";
import { getProfile, invalidateContext, rebuildProfile, recommend, setFeedback, storedProfile } from "./taste.js";

function findPackageJson() {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) return p;
    if (path.dirname(dir) === dir) throw new Error("package.json not found");
  }
}
const VERSION = JSON.parse(fs.readFileSync(findPackageJson(), "utf8")).version as string;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const PORT = Number(process.env.PORT ?? 8383);
const STARTED = Date.now();

/** Request URLs in logs without query strings or webhook keys. */
const redact = (url: string) => url.split("?")[0].replace(/(\/api\/webhook\/\w+\/)[^/]+/, "$1***");

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info", serializers: { req: (r) => ({ method: r.method, url: redact(r.url), remoteAddress: r.ip }) } },
  // proxy-addr accepts a hop count too; Fastify's types only list string | string[] | boolean.
  trustProxy: trustProxyOption() as string[] | false,
  bodyLimit: 1_000_000,
});
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.warn(err.message);
  reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: err.message });
});

const fail = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });
const parseSeason = (q: Record<string, string | undefined>) => {
  const cur = seasonOf();
  const season = (q.season?.toUpperCase() as Season | undefined) ?? cur.season;
  const year = Number(q.year) || cur.year;
  if (!SEASONS.includes(season) || year < 1960 || year > 2100) throw fail("Bad season");
  return { season, year };
};
const id = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail("Bad id");
  return n;
};

/** A stored secret is only re-used for the URL it was saved with, so it can't be sent somewhere new. */
function withSecret(url: unknown, secret: unknown, storedUrl: string, storedSecret: string) {
  const u = String(url ?? "").trim().replace(/\/+$/, "");
  const s = String(secret ?? "");
  if (s && !isMasked(s)) return { url: u, secret: s };
  if (u === storedUrl && storedSecret) return { url: u, secret: storedSecret };
  throw fail("Enter the API key/token again for a new address");
}

function sessionCookie(req: FastifyRequest, reply: FastifyReply, username: string) {
  reply.setCookie(COOKIE, makeSession(username), { path: "/", httpOnly: true, sameSite: "strict", secure: req.protocol === "https", maxAge: 30 * 86400 });
}

// ---------------------------------------------------------------- status & account

app.get("/api/status", { config: { setup: true } }, async (req) => {
  const s = getSettings();
  const a = authState(req);
  const base = { version: VERSION, setupRequired: a.setupRequired, loggedIn: a.ok };
  if (!a.ok) return base;
  return {
    ...base,
    via: a.via,
    sonarr: !!(s.sonarr.url && s.sonarr.apiKey),
    radarr: !!(s.radarr.url && s.radarr.apiKey),
    media: s.media.type !== "none" && !!s.media.url && !!s.media.token,
    lists: !!(s.lists.anilistUser || s.lists.malUser),
    quizAnswers: Object.keys(s.genrePrefs).length,
    profileBuiltAt: storedProfile()?.builtAt ?? null,
    season: seasonOf(),
  };
});

app.post<{ Body: { username?: string; password?: string; bypassLocal?: boolean } }>("/api/auth/setup", { config: { setup: true } }, async (req, reply) => {
  if (getSettings().auth.passwordHash) throw fail("Account already exists", 409);
  if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!username || password.length < 8) throw fail("Choose a username and a password of at least 8 characters");
  await setAccount(username, password);
  patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: req.body?.bypassLocal === true } }));
  sessionCookie(req, reply, username);
  return { ok: true };
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", { config: { setup: true } }, async (req, reply) => {
  if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
  if (!loginAllowed(req.ip)) throw fail("Too many attempts, try again in a few minutes", 429);
  const a = getSettings().auth;
  const okUser = safeEqual(String(req.body?.username ?? ""), a.username);
  const okPass = await checkPassword(String(req.body?.password ?? ""), a.passwordHash || "00:00");
  if (!okUser || !okPass) throw fail("Wrong username or password", 401);
  loginSucceeded(req.ip);
  sessionCookie(req, reply, a.username);
  return { ok: true };
});

app.post("/api/auth/logout", async (_req, reply) => {
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

app.put<{ Body: { currentPassword?: string; username?: string; password?: string } }>("/api/auth/account", async (req, reply) => {
  const a = getSettings().auth;
  if (!(await checkPassword(String(req.body?.currentPassword ?? ""), a.passwordHash))) throw fail("Current password is wrong", 403);
  const username = String(req.body?.username ?? a.username).trim() || a.username;
  const password = String(req.body?.password ?? "");
  if (password && password.length < 8) throw fail("New password must be at least 8 characters");
  if (password) await setAccount(username, password);
  else patchSettings((s) => ({ ...s, auth: { ...s.auth, username } }));
  sessionCookie(req, reply, username); // changing the password rotated the signing secret
  return { ok: true };
});

// ---------------------------------------------------------------- settings & connections

app.get("/api/settings", async () => publicSettings());
app.put<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
  updateSettings(req.body);
  invalidateContext();
  return publicSettings();
});

app.get("/api/settings/keys", async (req) => {
  const s = getSettings();
  // The admin key is only shown to a logged-in session, never via the local-network bypass.
  return { apiKey: authState(req).via === "session" ? s.apiKey : null, webhookKey: s.webhookKey };
});
app.post<{ Params: { which: string } }>("/api/settings/keys/:which/regenerate", async (req) => {
  if (req.params.which !== "apiKey" && req.params.which !== "webhookKey") throw fail("Unknown key");
  if (req.params.which === "apiKey" && authState(req).via !== "session") throw fail("Log in to manage the API key", 403);
  return { [req.params.which]: regenerateKey(req.params.which) };
});

app.get("/api/discover", async () => discover());
app.post<{ Body: { id: string; url: string } }>("/api/discover/use", async (req) => {
  const r = await useDiscovered(String(req.body?.id ?? ""), String(req.body?.url ?? ""));
  invalidateContext();
  return r;
});

app.post<{ Body: { url?: string; apiKey?: string } }>("/api/sonarr/test", async (req) => {
  const s = getSettings().sonarr;
  const c = withSecret(req.body?.url, req.body?.apiKey, s.url, s.apiKey);
  const conn = { url: c.url, apiKey: c.secret };
  return { ...(await testSonarr(conn)), options: await sonarrOptions(conn) };
});
app.post<{ Body: { url?: string; apiKey?: string } }>("/api/radarr/test", async (req) => {
  const s = getSettings().radarr;
  const c = withSecret(req.body?.url, req.body?.apiKey, s.url, s.apiKey);
  const conn = { url: c.url, apiKey: c.secret };
  return { ...(await testRadarr(conn)), options: await radarrOptions(conn) };
});

const mediaConn = (b: Partial<Settings["media"]> | undefined): Settings["media"] => {
  const cur = getSettings().media;
  const type = b?.type === "plex" || b?.type === "jellyfin" ? b.type : cur.type;
  const c = withSecret(b?.url ?? cur.url, b?.token, cur.url, cur.token);
  return { ...cur, type, url: c.url, token: c.secret, userId: String(b?.userId ?? cur.userId) };
};
app.post<{ Body: Partial<Settings["media"]> }>("/api/media/test", async (req) => {
  const conn = mediaConn(req.body);
  const info = await testMediaServer(conn);
  const users = conn.type === "jellyfin" ? await listJellyfinUsers(conn) : [];
  const libraries = conn.type === "plex" || conn.userId ? await listLibraries(conn).catch(() => []) : [];
  return { ...info, users, libraries };
});

// "Sign in with Plex": the account token stays on the server; the browser only ever sees server names and URLs.
const pins = new Map<number, { token: string | null; at: number }>();
app.post("/api/plex/pin", async () => {
  const pin = await plexCreatePin();
  pins.set(pin.id, { token: null, at: Date.now() });
  return pin;
});
app.get<{ Params: { id: string } }>("/api/plex/pin/:id", async (req) => {
  const pinId = id(req.params.id);
  const p = pins.get(pinId);
  if (!p || Date.now() - p.at > 15 * 60_000) throw fail("Sign-in expired, start again", 410);
  p.token ??= await plexCheckPin(pinId);
  if (!p.token) return { done: false };
  const servers = await plexServers(p.token);
  return { done: true, servers: servers.map(({ accessToken: _t, ...s }) => s) };
});
app.post<{ Body: { pinId: number; serverId: string; url: string } }>("/api/plex/server", async (req) => {
  const p = pins.get(Number(req.body?.pinId));
  if (!p?.token) throw fail("Sign in with Plex first", 410);
  const server = (await plexServers(p.token)).find((s) => s.id === req.body?.serverId);
  if (!server) throw fail("Server not found on your Plex account");
  const url = String(req.body?.url ?? "").replace(/\/+$/, "");
  if (!server.urls.includes(url) && !/^https?:\/\//i.test(url)) throw fail("Pick one of the server's addresses");
  const conn = { ...getSettings().media, type: "plex" as const, url, token: server.accessToken };
  const info = await testMediaServer(conn);
  patchSettings((s) => ({ ...s, media: { ...s.media, type: "plex", url, token: server.accessToken } }));
  pins.delete(Number(req.body?.pinId));
  invalidateContext();
  return { ...info, libraries: await listLibraries(conn).catch(() => []) };
});

app.post("/api/notify/test", async () => ({ sent: await send({ title: "Tastearr test", body: "Alerts are working 🎉" }) }));

app.post("/api/lists/import", async () => {
  const done = await refreshLists();
  invalidateContext();
  void rebuildProfile().catch(() => undefined);
  return { imported: done };
});

// ---------------------------------------------------------------- profile, jobs, system

app.get("/api/profile", async () => {
  const p = storedProfile();
  if (p) return p;
  void rebuildProfile().catch(() => undefined);
  return { building: true };
});
app.post("/api/profile/rebuild", async () => {
  void rebuildProfile().catch(() => undefined);
  return { started: true };
});
app.get("/api/system", async () => ({ version: VERSION, uptime: Date.now() - STARTED, node: process.version, jobs: listJobs() }));

// ---------------------------------------------------------------- picks

app.get<{ Querystring: Record<string, string | undefined> }>("/api/picks", async (req) => {
  const { season, year } = parseSeason(req.query);
  const r = await recommend(season, year, req.query.refresh === "1");
  const following = new Set(followedIds());
  return { season, year, ...r, picks: r.picks.map((p) => ({ ...p, following: following.has(p.id) })) };
});

app.post<{ Params: { id: string } }>("/api/picks/:id/add", async (req) => {
  const anilistId = id(req.params.id);
  const [m] = await getMediaByIds([anilistId]);
  if (!m) throw fail("Unknown show", 404);
  let r;
  if (m.format === "MOVIE") {
    const tmdb = (await mappingTables()).movieByAnilist.get(anilistId);
    if (!tmdb) throw fail("No TMDB match for this movie yet, so Radarr can't add it", 422);
    r = await addMovie(tmdb);
  } else {
    const map = await mapAnilist(anilistId);
    if (!map) throw fail("No TVDB match for this show yet, so Sonarr can't add it", 422);
    r = await addSeries(map.tvdbId, map.season);
  }
  setFeedback(anilistId, "added");
  invalidateContext();
  return r;
});
app.post<{ Params: { id: string } }>("/api/picks/:id/monitor", async (req) => {
  const anilistId = id(req.params.id);
  const map = await mapAnilist(anilistId);
  if (!map?.season) throw fail("Unknown season number for this entry", 422);
  const r = await monitorSeason(map.tvdbId, map.season);
  setFeedback(anilistId, "added");
  invalidateContext();
  return r;
});
app.post<{ Body: { id: number; verdict: string | null; source?: string } }>("/api/feedback", async (req) => {
  const anilistId = id(String(req.body?.id));
  const verdict = req.body?.verdict ?? null;
  if (![null, "loved", "liked", "meh", "disliked", "hidden", "added"].includes(verdict)) throw fail("Bad verdict");
  if (verdict) await getMediaByIds([anilistId]);
  setFeedback(anilistId, verdict, req.body?.source === "quiz" ? "quiz" : "picks");
  return { ok: true, verdict };
});

app.post<{ Params: { id: string } }>("/api/picks/:id/follow", async (req) => {
  const r = await follow(id(req.params.id));
  invalidateContext();
  return r;
});
app.post<{ Params: { id: string } }>("/api/picks/:id/unfollow", async (req) => unfollow(id(req.params.id)));

// ---------------------------------------------------------------- quiz

app.get("/api/quiz", async () => getQuiz());
app.put<{ Body: { genrePrefs: unknown } }>("/api/quiz/genres", async (req) => {
  setGenrePrefs(req.body?.genrePrefs);
  return { ok: true };
});

// ---------------------------------------------------------------- my shows

app.get("/api/shows", async () => ({
  sonarr: getSettings().sonarr.url ? await myShows() : [],
  following: await followedShows(),
}));
app.post<{ Params: { tvdbId: string } }>("/api/shows/:tvdbId/drop", async (req) => {
  const r = await dropShow(id(req.params.tvdbId));
  invalidateContext();
  return r;
});
app.post<{ Params: { tvdbId: string } }>("/api/shows/:tvdbId/undrop", async (req) => {
  const r = await undropShow(id(req.params.tvdbId));
  invalidateContext();
  return r;
});

// ---------------------------------------------------------------- incoming (own credentials)

app.post<{ Params: { key: string } }>("/api/webhook/sonarr/:key", { config: { public: true } }, async (req) => {
  if (!safeEqual(req.params.key, getSettings().webhookKey)) throw fail("Bad webhook key", 401);
  return { sent: await handleSonarrWebhook(req.body as Parameters<typeof handleSonarrWebhook>[0]) };
});
app.post<{ Params: { key: string } }>("/api/webhook/radarr/:key", { config: { public: true } }, async (req) => {
  if (!safeEqual(req.params.key, getSettings().webhookKey)) throw fail("Bad webhook key", 401);
  return { sent: await handleRadarrWebhook(req.body as Parameters<typeof handleRadarrWebhook>[0]) };
});
app.post<{ Params: { tvdbId: string }; Querystring: { exp?: string; sig?: string } }>("/api/actions/drop/:tvdbId", { config: { public: true } }, async (req) => {
  const tvdbId = id(req.params.tvdbId);
  if (!verifyAction("drop", tvdbId, Number(req.query.exp), String(req.query.sig ?? ""))) throw fail("This link has expired", 401);
  const r = await dropShow(tvdbId);
  invalidateContext();
  return { ok: true, message: `Dropped ${r.title}. You won't get alerts for it any more.` };
});

// ---------------------------------------------------------------- web UI

if (fs.existsSync(WEB_DIR)) {
  await app.register(fastifyStatic, { root: WEB_DIR, wildcard: false });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

// ---------------------------------------------------------------- background: refresh, rebuild, announce

async function tick() {
  try {
    setJob("refresh", "running", "Refreshing seasons");
    const cur = seasonOf();
    const next = shiftSeason(cur, 1);
    if (getSettings().auth.passwordHash) {
      await getProfile();
      await recommend(cur.season, cur.year);
      await notifySeason(next.season, next.year);
    }
    setJob("refresh", "done", "Seasons up to date");
  } catch (e) {
    setJob("refresh", "error", (e as Error).message);
    app.log.warn(`Background refresh failed: ${(e as Error).message}`);
  }
}
setTimeout(tick, 15_000);
setInterval(tick, 6 * 3_600_000);
setInterval(() => void announceAired().catch((e) => app.log.warn(`Airing alerts failed: ${(e as Error).message}`)), 30 * 60_000);

await app.listen({ host: "0.0.0.0", port: PORT });
