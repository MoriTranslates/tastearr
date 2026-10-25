import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { cachedMedia, getMediaByIds, searchTitle, seasonOf, shiftSeason, SEASONS, type Season } from "./anilist.js";
import { authState, COOKIE, csrfOk, guard, hostAllowed, isLocalRequest, isPrivateIp, loginAllowed, loginSucceeded, makeSession, PROXY_TRUSTED, SETUP_TOKEN, trustProxyOption, verifyAction } from "./auth.js";
import { CONFIG_DIR, db, listJobs, setJob } from "./db.js";
import { discover, useDiscovered } from "./discover.js";
import { announceAired, follow, followedIds, followedShows, unfollow } from "./following.js";
import { refreshLists } from "./lists.js";
import { clearOverrides, mapAnilist, mappingFileAge, mappingTables, saveOverride } from "./mapping.js";
import { listJellyfinUsers, listLibraries, plexCheckPin, plexCreatePin, plexServers, testMediaServer } from "./mediaserver.js";
import { notifySeason, send } from "./notify.js";
import { getQuiz, prewarmQuiz } from "./quiz.js";
import { addMovie, radarrOptions, testRadarr } from "./radarr.js";
import { checkPassword, getSettings, isMasked, patchSettings, publicSettings, regenerateKey, safeEqual, setAccount, setBypassLocal, setGenrePrefs, updateSettings, type Settings } from "./settings.js";
import { dropShow, handleRadarrWebhook, handleSonarrWebhook, myShows, undropShow } from "./shows.js";
import { addSeries, forgetSeries, lookupByTitle, monitorSeason, planAdd, seriesMonitored, sonarrOptions, sonarrSeries, testSonarr } from "./sonarr.js";
import { getProfile, invalidateContext, isBuilding, rebuildProfile, recommend, setFeedback, storedProfile, title } from "./taste.js";

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
const redact = (url: string) => url.split("?")[0].replace(/(\/api\/(?:webhook|importlist)\/\w+\/)[^/]+/, "$1***");

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

const monitorChoice = (v: unknown) => (["season", "all", "future", "none"] as const).find((x) => x === v);

/**
 * The TVDB season for a show matched by hand: one past its earlier season's when that maps to the same series. A split
 * cour ("Part 2", "2nd cour") is filed by TVDB under the same season as its first half.
 */
async function guessSeason(m: { title: { english: string | null; romaji: string | null }; relations?: { edges: { relationType: string; node: { id: number } }[] } | null }, tvdbId: number) {
  const splitCour = /part\s*(2|ii)|2nd cour|cour 2/i.test(`${m.title.english} ${m.title.romaji}`);
  // Walk back through recap specials/OVAs (TVDB season 0) to the last real season, like the picks do.
  let ids = (m.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL").map((e) => e.node.id);
  for (let depth = 0; depth < 3 && ids.length; depth++) {
    const next: number[] = [];
    for (const pid of ids) {
      const pm = await mapAnilist(pid);
      if (pm?.tvdbId === tvdbId && pm.season) return splitCour ? pm.season : pm.season + 1;
      const [pmedia] = await getMediaByIds([pid]);
      if (pmedia && pmedia.format !== "TV" && pmedia.format !== "ONA") next.push(...(pmedia.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL").map((e) => e.node.id));
    }
    ids = next;
  }
  return null;
}

/** Long-runners that TVDB files as one big "season 1" (several AniList entries map there): never grab it all. */
async function firstOfMany(map: { tvdbId: number; season: number | null }) {
  if (map.season !== 1) return false;
  const t = await mappingTables();
  const ids = (t.byTvdb.get(map.tvdbId) ?? []).filter((x) => t.byAnilist.get(x)?.season === 1);
  if (ids.length < 2) return false;
  const media = await getMediaByIds(ids);
  const years = media.map((x) => x.seasonYear ?? x.startDate?.year ?? 0).filter(Boolean);
  return media.some((x) => (x.episodes ?? 0) > 50) || (years.length > 1 && Math.max(...years) - Math.min(...years) >= 3);
}

/** A stored secret is only re-used for the URL it was saved with, so it can't be sent somewhere new. */
function withSecret(url: unknown, secret: unknown, storedUrl: string, storedSecret: string) {
  const u = checkOutbound(String(url ?? "").trim().replace(/\/+$/, ""));
  const s = String(secret ?? "");
  if (s && !isMasked(s)) return { url: u, secret: s };
  if (u === storedUrl && storedSecret) return { url: u, secret: storedSecret };
  throw fail("Enter the API key/token again for a new address");
}

/** Outbound service URLs: http(s) only, never link-local / cloud metadata addresses. */
function checkOutbound(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw fail("That address isn't a valid URL (it should start with http://)");
  }
  if (!/^https?:$/.test(u.protocol)) throw fail("Address must start with http:// or https://");
  if (/^(169\.254\.|0\.|\[?fe80:)/i.test(u.hostname) || u.hostname === "metadata.google.internal") throw fail("That address isn't allowed");
  return url;
}

function sessionCookie(req: FastifyRequest, reply: FastifyReply, username: string) {
  reply.setCookie(COOKIE, makeSession(username), { path: "/", httpOnly: true, sameSite: "strict", secure: req.protocol === "https", maxAge: 30 * 86400 });
}

// ---------------------------------------------------------------- status & account

/** Docker HEALTHCHECK / Uptime Kuma: no login, no data. */
app.get("/ping", async () => ({ status: "OK" }));

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
    alerts: !!(s.notify.ntfyUrl || (s.notify.gotifyUrl && s.notify.gotifyToken) || s.notify.discordWebhook),
    mode: s.mode,
    profileBuiltAt: storedProfile()?.builtAt ?? null,
    building: isBuilding(),
    prefs: { hideInLibrary: s.filters.hideInLibrary, hideShorts: s.filters.hideShorts, services: s.display.services, dropAction: s.sonarr.dropAction },
    warnings: warnings(),
    season: seasonOf(),
  };
});

/** Problems worth a banner (also listed under System -> Health). */
let legacyWebhookAt = 0;
let proxySeen = false;
const webhookSeen: Record<string, number> = {};
function warnings() {
  const out: string[] = [];
  if (legacyWebhookAt) out.push("Sonarr is still using the old webhook address, which has a key in the URL. Copy the new one from Settings → Alerts into Sonarr's Connect → Webhook.");
  if (proxySeen) out.push("If you use a reverse proxy, set the TRUST_PROXY variable to your proxy's IP address (not a hop count) so login protection sees real client addresses.");
  return out;
}

let settingUp = false;
app.post<{ Body: { username?: string; password?: string; bypassLocal?: boolean; setupToken?: string } }>("/api/auth/setup", { config: { setup: true } }, async (req, reply) => {
  if (getSettings().auth.passwordHash || settingUp) throw fail("Account already exists", 409);
  if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
  // A fresh install can only be claimed from the local network, or with the token printed in the container log.
  const local = isLocalRequest(req) && hostAllowed(req);
  if (!local && !safeEqual(String(req.body?.setupToken ?? ""), SETUP_TOKEN)) throw fail("Open Tastearr from your home network to create the account, or enter the setup code from the container log", 403);
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
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
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", { config: { setup: true } }, async (req, reply) => {
  if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
  // Only a real proxy (a LAN peer adding the header) counts; a forged header from outside can't raise the banner.
  if (!PROXY_TRUSTED && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) && isPrivateIp(req.socket.remoteAddress ?? "")) proxySeen = true;
  if (!loginAllowed(req.ip, String(req.body?.username ?? ""))) throw fail("Too many attempts, wait a few seconds and try again", 429);
  const a = getSettings().auth;
  const okUser = safeEqual(String(req.body?.username ?? ""), a.username);
  const okPass = await checkPassword(String(req.body?.password ?? ""), a.passwordHash || "00:00");
  if (!okUser || !okPass) throw fail("Wrong username or password", 401);
  loginSucceeded(req.ip, a.username);
  sessionCookie(req, reply, a.username);
  return { ok: true };
});

app.post("/api/auth/logout", async (_req, reply) => {
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

app.put<{ Body: { currentPassword?: string; username?: string; password?: string } }>("/api/auth/account", async (req, reply) => {
  const a = getSettings().auth;
  // Same throttle as login: a stolen session cookie shouldn't allow unlimited password guesses.
  if (!loginAllowed(req.ip, a.username)) throw fail("Too many attempts, wait a few seconds and try again", 429);
  if (!(await checkPassword(String(req.body?.currentPassword ?? ""), a.passwordHash))) throw fail("Current password is wrong", 403);
  loginSucceeded(req.ip, a.username);
  const username = String(req.body?.username ?? a.username).trim() || a.username;
  const password = String(req.body?.password ?? "");
  if (password && password.length < 8) throw fail("New password must be at least 8 characters");
  if (password) await setAccount(username, password);
  else patchSettings((s) => ({ ...s, auth: { ...s.auth, username } }));
  sessionCookie(req, reply, username); // changing the password rotated the signing secret
  return { ok: true };
});

/** "Authentication required" mode. Needs a real login session, so a bypassed LAN device can't turn the bypass on. */
app.put<{ Body: { bypassLocal?: boolean } }>("/api/auth/mode", async (req) => {
  if (authState(req).via !== "session") throw fail("Log in with your password to change this", 403);
  setBypassLocal(req.body?.bypassLocal === true);
  return { ok: true, bypassLocal: req.body?.bypassLocal === true };
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

// Extra Sonarr instances (read for "In library" and monitoring). Added here so their keys never round-trip the browser.
app.post<{ Body: { name?: string; url?: string; apiKey?: string } }>("/api/sonarr/extra", async (req) => {
  const s = getSettings();
  if (s.sonarrExtra.length >= 4) throw fail("Up to four extra Sonarr instances");
  const url = checkOutbound(String(req.body?.url ?? "").trim().replace(/\/+$/, ""));
  const apiKey = String(req.body?.apiKey ?? "").trim();
  if (!apiKey || isMasked(apiKey)) throw fail("Paste that Sonarr's API key");
  if (url === s.sonarr.url || s.sonarrExtra.some((x) => x.url === url)) throw fail("That Sonarr is already connected");
  const v = await testSonarr({ url, apiKey });
  const name = String(req.body?.name ?? "").trim().slice(0, 40) || new URL(url).host;
  patchSettings((x) => ({ ...x, sonarrExtra: [...x.sonarrExtra, { name, url, apiKey }] }));
  forgetSeries();
  invalidateContext();
  return { ok: true, version: v.version };
});
app.delete<{ Params: { i: string } }>("/api/sonarr/extra/:i", async (req) => {
  const i = Number(req.params.i);
  patchSettings((x) => ({ ...x, sonarrExtra: x.sonarrExtra.filter((_, k) => k !== i) }));
  forgetSeries();
  invalidateContext();
  return { ok: true };
});

app.get("/api/discover", async () => discover());
app.post<{ Body: { id: string; url: string } }>("/api/discover/use", async (req) => {
  const r = await useDiscovered(String(req.body?.id ?? ""), String(req.body?.url ?? ""), authState(req).via === "session");
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
const prunePins = () => {
  for (const [k, v] of pins) if (Date.now() - v.at > 15 * 60_000) pins.delete(k);
};
app.post("/api/plex/pin", async () => {
  prunePins();
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
  if (!server.urls.includes(url)) throw fail("Pick one of the server's own addresses");
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
  // The build that's running now (it may have started earlier, e.g. right after a list import): the UI follows this one.
  return { started: true, startedAt: listJobs().find((j) => j.name === "profile")?.startedAt ?? Date.now() };
});
app.get("/api/system", async () => ({ version: VERSION, uptime: Date.now() - STARTED, node: process.version, jobs: listJobs() }));

/** Like Sonarr's System -> Status -> Health: each connection and background job, with a plain-language fix. */
app.get("/api/system/health", async () => {
  const s = getSettings();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const probe = async (name: string, on: boolean, fn: () => Promise<unknown>, fix: string) => {
    if (!on) return;
    try {
      await fn();
      checks.push({ name, ok: true, detail: "Connected" });
    } catch (e) {
      checks.push({ name, ok: false, detail: `${(e as Error).message}. ${fix}` });
    }
  };
  await Promise.all([
    probe("Sonarr", !!(s.sonarr.url && s.sonarr.apiKey), () => testSonarr(s.sonarr), "Check the address and API key in Settings → Connections."),
    ...s.sonarrExtra.map((x) => probe(`Sonarr (${x.name})`, true, () => testSonarr(x), "Check it in Settings → Connections.")),
    probe("Radarr", !!(s.radarr.url && s.radarr.apiKey), () => testRadarr(s.radarr), "Check the address and API key in Settings → Connections."),
    probe(s.media.type === "plex" ? "Plex" : "Jellyfin", s.media.type !== "none" && !!s.media.url, () => testMediaServer(s.media), "Sign in again in Settings → Connections."),
  ]);
  const age = mappingFileAge();
  const fresh = age !== null && age < 14 * 86_400_000;
  checks.push({
    name: "Anime ID list",
    ok: fresh,
    detail: age === null ? "Not downloaded yet; it's fetched from GitHub on the first picks load." : fresh ? `Updated ${Math.round(age / 86_400_000)} days ago` : "Couldn't refresh from GitHub for over two weeks; new shows may lack Sonarr matches.",
  });
  for (const j of listJobs()) if (j.state === "error") checks.push({ name: `Background job: ${j.name}`, ok: false, detail: String(j.detail ?? "") });
  for (const w of warnings()) checks.push({ name: "Setup", ok: false, detail: w });
  for (const app of ["sonarr", "radarr"] as const) {
    if (!(s[app].url && s[app].apiKey)) continue;
    const at = webhookSeen[app];
    const name = `${app === "sonarr" ? "Sonarr" : "Radarr"} webhook`;
    if (!at) checks.push({ name, ok: true, detail: "Not heard from since Tastearr started. That's normal until something downloads; if alerts never arrive, add the webhook from Settings → Alerts." });
    else checks.push({ name, ok: true, detail: `Last heard from ${Math.round((Date.now() - at) / 3_600_000)} hours ago` });
  }
  return { checks };
});

/** A copy of the database (settings, keys, taste data). It contains every secret, so it asks for the password again. */
app.post<{ Body: { password?: string } }>("/api/system/backup", async (req, reply) => {
  // The password itself authorises this (so home-network-bypass users can back up too); the admin key alone can't.
  if (authState(req).via === "apikey") throw fail("Backups need the account password", 403);
  if (!loginAllowed(req.ip, getSettings().auth.username)) throw fail("Too many attempts, wait a few seconds and try again", 429);
  if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
  loginSucceeded(req.ip, getSettings().auth.username);
  const tmp = path.join(CONFIG_DIR, `backup-${Date.now()}.db`);
  let data: Buffer;
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    data = fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return reply.header("Content-Type", "application/octet-stream").header("Content-Disposition", `attachment; filename="tastearr-backup-${stamp}.db"`).send(data);
});

/** Forgets matches picked by hand; the community list applies again. */
app.post("/api/mapping/reset", async (req) => {
  if (authState(req).via !== "session") throw fail("Log in with your password to reset matches", 403);
  const n = clearOverrides();
  invalidateContext();
  return { cleared: n };
});

// ---------------------------------------------------------------- picks

app.get<{ Querystring: Record<string, string | undefined> }>("/api/picks", async (req) => {
  const { season, year } = parseSeason(req.query);
  const r = await recommend(season, year, req.query.refresh === "1");
  const following = new Set(followedIds());
  return { season, year, ...r, picks: r.picks.map((p) => ({ ...p, following: following.has(p.id) })) };
});

/** What "Add" will do, shown in the confirm dialog before anything is written to Sonarr/Radarr. */
app.get<{ Params: { id: string }; Querystring: { tvdbId?: string; season?: string } }>("/api/picks/:id/plan", async (req) => {
  const anilistId = id(req.params.id);
  const [m] = await getMediaByIds([anilistId]);
  if (!m) throw fail("Unknown show", 404);
  if (m.format === "MOVIE") {
    const t = await mappingTables();
    const tmdb = t.movieByAnilist.get(anilistId);
    const imdb = t.imdbByAnilist.get(anilistId);
    if (!tmdb && !imdb) throw fail("This movie isn't matched to TMDB or IMDb yet, so Radarr can't find it", 422);
    const r = getSettings().radarr;
    return { app: "radarr", title: m.title.english || m.title.romaji, rootFolder: r.rootFolderPath, search: r.searchOnAdd, minimumAvailability: r.minimumAvailability };
  }
  // A candidate picked from Sonarr's title search: preview it with the season guessed from its earlier season.
  if (req.query.tvdbId) {
    const tvdbId = id(req.query.tvdbId);
    const season = req.query.season ? id(req.query.season) : await guessSeason(m, tvdbId);
    const owned = (await sonarrSeries()).some((x) => x.tvdbId === tvdbId);
    return { app: "sonarr", ...(await planAdd(tvdbId, season)), alreadyInLibrary: owned, resumesSeries: (await seriesMonitored(tvdbId)) === false };
  }
  const map = await mapAnilist(anilistId);
  if (!map) return { app: "sonarr", needsMatch: true };
  return { app: "sonarr", ...(await planAdd(map.tvdbId, map.season, await firstOfMany(map))), resumesSeries: (await seriesMonitored(map.tvdbId)) === false };
});

/** Sonarr title-search candidates when the community mapping has no TVDB match yet. */
app.get<{ Params: { id: string } }>("/api/picks/:id/candidates", async (req) => {
  const [m] = await getMediaByIds([id(req.params.id)]);
  if (!m) throw fail("Unknown show", 404);
  return lookupByTitle([m.title.english ?? "", m.title.romaji ?? ""], m.startDate?.year ?? m.seasonYear ?? null);
});

app.post<{ Params: { id: string }; Body: { monitor?: string; search?: boolean; tvdbId?: number; season?: number | null } }>("/api/picks/:id/add", async (req) => {
  const anilistId = id(req.params.id);
  const [m] = await getMediaByIds([anilistId]);
  if (!m) throw fail("Unknown show", 404);
  let r;
  if (m.format === "MOVIE") {
    const t = await mappingTables();
    r = await addMovie({ tmdbId: t.movieByAnilist.get(anilistId), imdbId: t.imdbByAnilist.get(anilistId) });
  } else if (req.body?.tvdbId) {
    // A match picked from Sonarr's title search. Only results of that search are accepted, and the match is
    // remembered only once Sonarr took it, so a failed add can't leave a wrong match behind.
    const tvdbId = id(String(req.body.tvdbId));
    const current = await mapAnilist(anilistId);
    const cands = current?.tvdbId === tvdbId ? [] : await lookupByTitle([m.title.english ?? "", m.title.romaji ?? ""], m.startDate?.year ?? m.seasonYear ?? null);
    if (current?.tvdbId !== tvdbId && !cands.some((c) => c.tvdbId === tvdbId)) throw fail("That isn't one of Sonarr's matches for this show", 422);
    const asked = Number(req.body.season);
    const season = Number.isInteger(asked) && asked >= 1 && asked <= 100 ? asked : await guessSeason(m, tvdbId);
    const owned = (await sonarrSeries(true)).some((x) => x.tvdbId === tvdbId);
    // Never remember "this show is that series, season unknown" for something already in Sonarr: it would hide the
    // "get the new season" choice for good. Ask for the season instead.
    if (owned && !season) throw fail("This series is already in Sonarr. Choose which season this is.", 422);
    if (owned) r = await monitorSeason(tvdbId, season!);
    else r = await addSeries(tvdbId, season, { monitor: monitorChoice(req.body.monitor), search: typeof req.body.search === "boolean" ? req.body.search : undefined });
    await saveOverride(anilistId, tvdbId, season);
  } else {
    const map = await mapAnilist(anilistId);
    if (!map) throw fail("Pick the matching show first", 422);
    const owned = (await sonarrSeries()).some((x) => x.tvdbId === map.tvdbId);
    if (owned) {
      if (!map.season) throw fail("This show is already in Sonarr", 409);
      r = await monitorSeason(map.tvdbId, map.season);
    } else r = await addSeries(map.tvdbId, map.season, { monitor: monitorChoice(req.body?.monitor), search: typeof req.body?.search === "boolean" ? req.body.search : undefined, firstOfMany: await firstOfMany(map) });
  }
  setFeedback(anilistId, "added");
  invalidateContext();
  return r;
});
app.post<{ Params: { id: string }; Body: { search?: boolean } }>("/api/picks/:id/monitor", async (req) => {
  const anilistId = id(req.params.id);
  const map = await mapAnilist(anilistId);
  if (!map?.season) throw fail("Unknown season number for this entry", 422);
  const r = await monitorSeason(map.tvdbId, map.season, typeof req.body?.search === "boolean" ? req.body.search : undefined);
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
/** "Add a show you've seen" in the quiz. */
app.get<{ Querystring: { q?: string } }>("/api/quiz/search", async (req) => {
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  if (q.length < 2) return [];
  return (await searchTitle(q)).map((m) => ({ id: m.id, title: title(m), cover: m.coverImage.large, year: m.seasonYear ?? m.startDate?.year ?? null, format: m.format }));
});
app.put<{ Body: { noGore?: boolean } }>("/api/quiz/content", async (req) => {
  patchSettings((s) => ({ ...s, filters: { ...s.filters, noGore: req.body?.noGore === true } }));
  invalidateContext();
  return { ok: true };
});
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

// v0.1 webhook address (?apikey=<key>). Still works with the webhook key so upgrades don't silently lose alerts (with a
// warning until Sonarr is pointed at the new address); the admin key is no longer accepted in a URL.
app.post<{ Querystring: { apikey?: string } }>("/api/webhook/sonarr", { config: { public: true } }, async (req) => {
  const s = getSettings();
  if (safeEqual(req.query.apikey, s.apiKey)) {
    legacyWebhookAt = Date.now();
    throw fail("Bad webhook key", 401); // the in-app banner explains the new address
  }
  if (!safeEqual(req.query.apikey, s.webhookKey)) throw fail("Bad webhook key", 401);
  legacyWebhookAt = Date.now();
  app.log.warn("Sonarr is using the old v0.1 webhook address. Update it to the one shown in Settings → Alerts.");
  return { sent: await handleSonarrWebhook(req.body as Parameters<typeof handleSonarrWebhook>[0]) };
});
app.post<{ Params: { key: string } }>("/api/webhook/sonarr/:key", { config: { public: true } }, async (req) => {
  if (!safeEqual(req.params.key, getSettings().webhookKey)) throw fail("Bad webhook key", 401);
  webhookSeen.sonarr = Date.now();
  legacyWebhookAt = 0;
  return { sent: await handleSonarrWebhook(req.body as Parameters<typeof handleSonarrWebhook>[0]) };
});
app.post<{ Params: { key: string } }>("/api/webhook/radarr/:key", { config: { public: true } }, async (req) => {
  if (!safeEqual(req.params.key, getSettings().webhookKey)) throw fail("Bad webhook key", 401);
  webhookSeen.radarr = Date.now();
  return { sent: await handleRadarrWebhook(req.body as Parameters<typeof handleRadarrWebhook>[0]) };
});

/**
 * Import lists, for people who'd rather Sonarr/Radarr pull picks than let Tastearr write to them. Sonarr's "Custom
 * List" reads [{ tvdbId }]; Radarr's "Custom List" reads [{ id }] (TMDB). Lists shows given 👍 or ♥ on the Picks page.
 */
const wanted = () =>
  (db.prepare("SELECT anilist_id FROM feedback WHERE source = 'picks' AND verdict IN ('liked', 'loved') AND at > ?").all(Date.now() - 120 * 86_400_000) as { anilist_id: number }[]).map(
    (r) => r.anilist_id,
  );
const listTitle = (id: number) => {
  const m = cachedMedia(id);
  return m ? title(m) : undefined;
};
app.get<{ Params: { key: string } }>("/api/importlist/sonarr/:key", { config: { public: true } }, async (req) => {
  if (!safeEqual(req.params.key, getSettings().webhookKey)) throw fail("Bad key", 401);
  const t = await mappingTables();
  const out = new Map<number, string | undefined>();
  for (const a of wanted()) {
    const tvdbId = t.byAnilist.get(a)?.tvdbId;
    if (tvdbId && !out.has(tvdbId)) out.set(tvdbId, listTitle(a));
  }
  return [...out].map(([tvdbId, title]) => ({ tvdbId, title }));
});
app.get<{ Params: { key: string } }>("/api/importlist/radarr/:key", { config: { public: true } }, async (req) => {
  if (!safeEqual(req.params.key, getSettings().webhookKey)) throw fail("Bad key", 401);
  const t = await mappingTables();
  const out = new Map<number, string | undefined>();
  for (const a of wanted()) {
    const tmdb = t.movieByAnilist.get(a);
    if (tmdb && !out.has(tmdb)) out.set(tmdb, listTitle(a));
  }
  return [...out].map(([id, title]) => ({ id, title }));
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
// A new install with nothing connected will start with the quiz: have it ready.
if (!getSettings().sonarr.url && !getSettings().lists.anilistUser && Object.keys(getSettings().genrePrefs).length === 0) setTimeout(prewarmQuiz, 3_000);
setInterval(tick, 6 * 3_600_000);
setInterval(() => void announceAired().catch((e) => app.log.warn(`Airing alerts failed: ${(e as Error).message}`)), 30 * 60_000);

await app.listen({ host: "0.0.0.0", port: PORT });
if (!getSettings().auth.passwordHash)
  app.log.warn(`No account yet. Open Tastearr from your home network to create one, or use setup code ${SETUP_TOKEN} from elsewhere (one-time, changes on restart, safe to redact from shared logs).`);
