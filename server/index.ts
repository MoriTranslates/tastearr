import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { getMediaByIds, seasonOf, shiftSeason, SEASONS, type Season } from "./anilist.js";
import { authState, COOKIE, guard, makeSession } from "./auth.js";
import { discover } from "./discover.js";
import { mapAnilist } from "./mapping.js";
import { listJellyfinUsers, listLibraries, testMediaServer } from "./mediaserver.js";
import { notifySeason, send } from "./notify.js";
import { getQuiz } from "./quiz.js";
import { checkPassword, getSettings, isMasked, publicSettings, regenerateApiKey, setGenrePrefs, updateSettings, type Pref, type Settings } from "./settings.js";
import { dropShow, handleSonarrWebhook, myShows, undropShow } from "./shows.js";
import { addSeries, monitorSeason, sonarrOptions, testSonarr } from "./sonarr.js";
import { buildProfile, getProfile, recommend, setFeedback, storedProfile } from "./taste.js";

const VERSION = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const PORT = Number(process.env.PORT ?? 8383);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: process.env.TRUST_PROXY === "true" });
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.warn(err.message);
  reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: err.message });
});

const parseSeason = (q: Record<string, string | undefined>) => {
  const cur = seasonOf();
  const season = (q.season?.toUpperCase() as Season) ?? cur.season;
  const year = Number(q.year) || cur.year;
  if (!SEASONS.includes(season)) throw Object.assign(new Error("Bad season"), { statusCode: 400 });
  return { season, year };
};
const secretOr = (v: string | undefined, stored: string) => (!v || isMasked(v) ? stored : v);

// --- status & auth
app.get("/api/status", async (req) => {
  const s = getSettings();
  const a = authState(req);
  return {
    version: VERSION,
    authRequired: a.required,
    loggedIn: a.ok,
    sonarr: !!(s.sonarr.url && s.sonarr.apiKey),
    media: s.media.type !== "none" && !!s.media.url,
    quizAnswers: Object.keys(s.genrePrefs).length,
    profileBuiltAt: storedProfile()?.builtAt ?? null,
    season: seasonOf(),
  };
});
app.post<{ Body: { username: string; password: string } }>("/api/auth/login", async (req, reply) => {
  const a = getSettings().auth;
  if (req.body.username !== a.username || !checkPassword(req.body.password ?? "", a.passwordHash)) return reply.code(401).send({ error: "Wrong username or password" });
  reply.setCookie(COOKIE, makeSession(a.username), { path: "/", httpOnly: true, sameSite: "lax", maxAge: 30 * 86400 });
  return { ok: true };
});
app.post("/api/auth/logout", async (_req, reply) => {
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

// --- settings & connections
app.get("/api/settings", async () => publicSettings());
app.put<{ Body: { settings: Partial<Settings>; password?: string } }>("/api/settings", async (req) => {
  updateSettings(req.body.settings as Record<string, unknown>, req.body.password);
  return publicSettings();
});
app.post("/api/settings/apikey", async () => ({ apiKey: regenerateApiKey() }));
app.get("/api/discover", async () => discover());
app.post<{ Body: { url: string; apiKey: string } }>("/api/test/sonarr", async (req) => testSonarr(req.body.url, secretOr(req.body.apiKey, getSettings().sonarr.apiKey)));
app.get("/api/sonarr/options", async () => sonarrOptions());
const mediaConn = (b: Partial<Settings["media"]>): Settings["media"] => {
  const cur = getSettings().media;
  return { ...cur, ...b, url: (b.url ?? cur.url).replace(/\/+$/, ""), token: secretOr(b.token, cur.token) };
};
app.post<{ Body: Partial<Settings["media"]> }>("/api/test/media", async (req) => testMediaServer(mediaConn(req.body)));
app.post<{ Body: Partial<Settings["media"]> }>("/api/media/libraries", async (req) => listLibraries(mediaConn(req.body)));
app.post<{ Body: Partial<Settings["media"]> }>("/api/media/users", async (req) => listJellyfinUsers(mediaConn(req.body)));
app.post("/api/test/notify", async () => ({ sent: await send({ title: "Tastearr test", body: "Alerts are working 🎉" }) }));

// --- taste profile
app.get("/api/profile", async () => getProfile());
app.post("/api/profile/rebuild", async () => buildProfile());

// --- seasonal picks
app.get<{ Querystring: Record<string, string | undefined> }>("/api/picks", async (req) => {
  const { season, year } = parseSeason(req.query);
  return { season, year, ...(await recommend(season, year, req.query.refresh === "1")) };
});
const mapped = async (id: number) => {
  const m = await mapAnilist(id);
  if (!m) throw Object.assign(new Error("No TVDB match for this show yet, so Sonarr can't add it"), { statusCode: 422 });
  return m;
};
app.post<{ Params: { id: string } }>("/api/picks/:id/add", async (req) => {
  const id = Number(req.params.id);
  const m = await mapped(id);
  const r = await addSeries(m.tvdbId, m.season);
  setFeedback(id, "added");
  return r;
});
app.post<{ Params: { id: string } }>("/api/picks/:id/monitor", async (req) => {
  const id = Number(req.params.id);
  const m = await mapped(id);
  if (!m.season) throw Object.assign(new Error("Unknown season number for this entry"), { statusCode: 422 });
  const r = await monitorSeason(m.tvdbId, m.season);
  setFeedback(id, "added");
  return r;
});
app.post<{ Body: { id: number; verdict: string | null; source?: string } }>("/api/feedback", async (req) => {
  const { id, verdict, source } = req.body;
  const allowed = ["loved", "liked", "meh", "disliked", "hidden", "added", null];
  if (!allowed.includes(verdict)) throw Object.assign(new Error("Bad verdict"), { statusCode: 400 });
  if (verdict) await getMediaByIds([id]); // make sure the show is cached for training
  setFeedback(id, verdict, source === "quiz" ? "quiz" : "picks");
  return { ok: true };
});

// --- quiz
app.get("/api/quiz", async () => getQuiz());
app.put<{ Body: { genrePrefs: Record<string, Pref> } }>("/api/quiz/genres", async (req) => {
  setGenrePrefs(req.body.genrePrefs);
  return { ok: true };
});

// --- my shows & webhook
app.get("/api/shows", async () => myShows());
app.post<{ Params: { tvdbId: string } }>("/api/shows/:tvdbId/drop", async (req) => dropShow(Number(req.params.tvdbId)));
app.post<{ Params: { tvdbId: string } }>("/api/shows/:tvdbId/undrop", async (req) => undropShow(Number(req.params.tvdbId)));
app.post("/api/webhook/sonarr", async (req) => ({ sent: await handleSonarrWebhook(req.body as Parameters<typeof handleSonarrWebhook>[0]) }));

// --- web UI
if (fs.existsSync(WEB_DIR)) {
  await app.register(fastifyStatic, { root: WEB_DIR, wildcard: false });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
}

// --- background jobs: refresh seasons, rebuild the profile daily, announce next season's picks
async function tick() {
  try {
    const cur = seasonOf();
    const next = shiftSeason(cur, 1);
    await getProfile();
    await recommend(cur.season, cur.year);
    await notifySeason(next.season, next.year);
  } catch (e) {
    app.log.warn(`Background refresh failed: ${(e as Error).message}`);
  }
}
setTimeout(tick, 15_000);
setInterval(tick, 6 * 3_600_000);

await app.listen({ host: "0.0.0.0", port: PORT });
