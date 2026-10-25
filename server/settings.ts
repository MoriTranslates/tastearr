import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Pref = "love" | "ok" | "never";

export interface Settings {
  sonarr: {
    url: string;
    apiKey: string;
    qualityProfileId: number | null;
    rootFolderPath: string;
    tags: number[];
    /** For sequels of shows not in the library: monitor only the airing season, or the whole series. */
    sequelMonitor: "newSeason" | "all";
    searchOnAdd: boolean;
    /** What "not into it anymore" does in Sonarr. */
    dropAction: "unmonitor" | "keep";
  };
  /** More Sonarr instances (a separate anime or 4K Sonarr). Read for "In library" and monitoring; adds go to the main one. */
  sonarrExtra: { name: string; url: string; apiKey: string }[];
  radarr: {
    url: string;
    apiKey: string;
    qualityProfileId: number | null;
    rootFolderPath: string;
    tags: number[];
    minimumAvailability: "announced" | "inCinemas" | "released";
    searchOnAdd: boolean;
  };
  media: {
    type: "none" | "plex" | "jellyfin";
    url: string;
    token: string;
    /** Jellyfin/Emby user id. Unused for Plex (the token's account is used). */
    userId: string;
    /** Library section ids (Plex) or parent ids (Jellyfin) holding anime. Empty = all show libraries. */
    libraryIds: string[];
  };
  lists: { anilistUser: string; malUser: string; malClientId: string };
  training: { seasons: number; minTagRank: number; formats: string[]; countries: string[] };
  filters: { excludeGenres: string[]; excludeTags: string[]; hideInLibrary: boolean; hideShorts: boolean; noGore: boolean };
  /** services: streaming sites the user has; shown first on cards and used as the default Schedule filter. */
  display: { titleLanguage: "english" | "romaji" | "native"; services: string[] };
  /** How the user watches: "server" (Sonarr/Plex) or "stream" (Crunchyroll etc.). Shapes the setup guide and wording. */
  mode: "server" | "stream" | "";
  /** Quiz genre answers. "never" genres are excluded outright. */
  genrePrefs: Record<string, Pref>;
  notify: {
    discordWebhook: string;
    /** Full ntfy topic URL, e.g. https://ntfy.sh/my-anime-alerts */
    ntfyUrl: string;
    ntfyToken: string;
    gotifyUrl: string;
    gotifyToken: string;
    /** Number of shows in the new-season message. */
    picks: number;
    seasonAlerts: boolean;
    /** New-episode alerts from Sonarr/Radarr imports. */
    episodeAlerts: boolean;
    /** "Episode N is out" alerts for followed shows, from AniList's airing schedule (no Sonarr needed). */
    airingAlerts: boolean;
    /** Minutes after the Japanese broadcast before a followed show's alert fires (simulcasts land later). */
    airingDelayMin: number;
  };
  /** Address phones and browsers reach Tastearr at (reverse proxy URL). Used for alert buttons and the Host check. */
  externalUrl: string;
  /** Login is always required once an account exists. bypassLocal is an explicit opt-in. */
  auth: { username: string; passwordHash: string; bypassLocal: boolean };
  /** Admin API key, accepted only in the X-Api-Key header. */
  apiKey: string;
  /** Scoped key that only works for incoming webhooks. */
  webhookKey: string;
  /** Identifies this install to plex.tv for the "Sign in with Plex" flow. */
  plexClientId: string;
  secret: string;
}

const DEFAULTS: Settings = {
  sonarr: { url: "", apiKey: "", qualityProfileId: null, rootFolderPath: "", tags: [], sequelMonitor: "newSeason", searchOnAdd: true, dropAction: "unmonitor" },
  sonarrExtra: [],
  radarr: { url: "", apiKey: "", qualityProfileId: null, rootFolderPath: "", tags: [], minimumAvailability: "released", searchOnAdd: true },
  media: { type: "none", url: "", token: "", userId: "", libraryIds: [] },
  lists: { anilistUser: "", malUser: "", malClientId: "" },
  training: { seasons: 8, minTagRank: 60, formats: ["TV", "TV_SHORT", "ONA"], countries: ["JP"] },
  filters: { excludeGenres: [], excludeTags: ["Kids"], hideInLibrary: false, hideShorts: false, noGore: false },
  display: { titleLanguage: "english", services: [] },
  mode: "",
  genrePrefs: {},
  notify: { discordWebhook: "", ntfyUrl: "", ntfyToken: "", gotifyUrl: "", gotifyToken: "", picks: 10, seasonAlerts: true, episodeAlerts: true, airingAlerts: true, airingDelayMin: 60 },
  externalUrl: "",
  auth: { username: "", passwordHash: "", bypassLocal: false },
  apiKey: "",
  webhookKey: "",
  plexClientId: "",
  secret: "",
};

const SECRET_PATHS = ["sonarr.apiKey", "radarr.apiKey", "media.token", "notify.discordWebhook", "notify.ntfyToken", "notify.gotifyToken", "lists.malClientId"] as const;
/** Settings the browser may change through PUT /api/settings. Everything else has its own endpoint. */
const EDITABLE = ["sonarr", "radarr", "media", "lists", "training", "filters", "display", "notify", "externalUrl", "mode"];
/** Each secret is only valid for the address it was saved with: if the address changes, a masked secret is dropped. */
const SECRET_FOR_URL: [string, string][] = [
  ["sonarr.url", "sonarr.apiKey"],
  ["radarr.url", "radarr.apiKey"],
  ["media.url", "media.token"],
  ["notify.ntfyUrl", "notify.ntfyToken"],
  ["notify.gotifyUrl", "notify.gotifyToken"],
];
const ENUMS: Record<string, readonly string[]> = {
  "sonarr.sequelMonitor": ["newSeason", "all"],
  "sonarr.dropAction": ["unmonitor", "keep"],
  "media.type": ["none", "plex", "jellyfin"],
  "radarr.minimumAvailability": ["announced", "inCinemas", "released"],
  "display.titleLanguage": ["english", "romaji", "native"],
  mode: ["server", "stream", ""],
};
const RANGES: Record<string, [number, number]> = { "training.seasons": [2, 24], "training.minTagRank": [0, 100], "notify.picks": [3, 30], "notify.airingDelayMin": [0, 1440] };

export const MASK = "••••••••";
/** True for the mask (or a mangled copy of it); real keys are printable ASCII. */
export const isMasked = (v: unknown) => typeof v === "string" && (v === MASK || /^[^ -~]+$/.test(v));

const rand = (n: number) => crypto.randomBytes(n).toString("hex");

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over) || base === null || typeof base !== "object" || Array.isArray(base)) {
    return (over === undefined ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

/** Coerces an untrusted patch into the shape of `shape`, dropping unknown keys and wrong types. */
function sanitize(shape: unknown, patch: unknown, path = ""): unknown {
  if (Array.isArray(shape)) {
    if (!Array.isArray(patch)) return undefined;
    const numeric = path === "sonarr.tags" || path === "radarr.tags";
    return patch.map((x) => (numeric ? Number(x) : String(x))).filter((x) => (numeric ? Number.isFinite(x) : x !== ""));
  }
  if (shape !== null && typeof shape === "object") {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!(k in (shape as object))) continue;
      const clean = sanitize((shape as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  if (path === "sonarr.qualityProfileId" || path === "radarr.qualityProfileId") return patch === null || patch === "" ? null : Number.isFinite(Number(patch)) ? Number(patch) : undefined;
  if (typeof shape === "boolean") return typeof patch === "boolean" ? patch : undefined;
  if (typeof shape === "number") {
    const n = Number(patch);
    if (!Number.isFinite(n)) return undefined;
    const r = RANGES[path];
    return r ? Math.min(r[1], Math.max(r[0], Math.round(n))) : n;
  }
  if (typeof shape === "string") {
    if (patch === null || patch === undefined) return undefined;
    const s = String(patch).trim();
    if (ENUMS[path] && !ENUMS[path].includes(s)) return undefined;
    return s;
  }
  return undefined;
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
  const stored = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
  let s = merge(DEFAULTS, stored);
  // v0.1 had auth.enabled and a local bypass that defaulted on; v0.2 always requires an account.
  if (stored.auth && "enabled" in (stored.auth as object)) s = { ...s, auth: { username: s.auth.username, passwordHash: s.auth.passwordHash, bypassLocal: false } };
  const missing = !s.apiKey || !s.secret || !s.webhookKey || !s.plexClientId;
  if (missing) s = { ...s, apiKey: s.apiKey || rand(16), secret: s.secret || rand(32), webhookKey: s.webhookKey || rand(16), plexClientId: s.plexClientId || crypto.randomUUID() };
  if (missing || (stored.auth && "enabled" in (stored.auth as object))) write(s);
  cache = s;
  return s;
}

function write(s: Settings) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
  cache = s;
}

function getPath(o: unknown, p: string): unknown {
  return p.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);
}

function setPath(o: Record<string, unknown>, p: string, v: unknown) {
  const keys = p.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys.at(-1)!] = v;
}

/** Settings as sent to the browser: every secret masked, hashes and signing keys removed. */
export function publicSettings() {
  const s = structuredClone(getSettings()) as unknown as Record<string, unknown>;
  for (const p of SECRET_PATHS) if (getPath(s, p)) setPath(s, p, MASK);
  const auth = s.auth as Record<string, unknown>;
  auth.hasPassword = !!auth.passwordHash;
  delete auth.passwordHash;
  s.sonarrExtra = (s.sonarrExtra as Settings["sonarrExtra"]).map((x) => ({ ...x, apiKey: MASK }));
  delete s.secret;
  delete s.apiKey;
  delete s.plexClientId;
  return s;
}

/** Applies an untrusted partial update from the browser. Masked secrets mean "unchanged". */
export function updateSettings(patch: unknown) {
  const cur = getSettings();
  const clean = sanitize(DEFAULTS, patch) as Record<string, unknown> | undefined;
  const allowed: Record<string, unknown> = {};
  for (const p of EDITABLE) {
    const v = getPath(clean, p);
    if (v === undefined) continue;
    const keys = p.split(".");
    let o = allowed;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[keys.at(-1)!] = v;
  }
  const next = merge(cur, allowed) as Settings;
  for (const p of SECRET_PATHS) if (isMasked(getPath(next, p))) setPath(next as unknown as Record<string, unknown>, p, getPath(cur, p));
  next.sonarr.url = next.sonarr.url.replace(/\/+$/, "");
  next.radarr.url = next.radarr.url.replace(/\/+$/, "");
  next.media.url = next.media.url.replace(/\/+$/, "");
  next.notify.ntfyUrl = normaliseNtfy(next.notify.ntfyUrl);
  for (const [u, k] of SECRET_FOR_URL) {
    const submitted = getPath(allowed, k);
    const keptOld = submitted === undefined || isMasked(submitted);
    // Compare normalised forms, so an address stored before normalisation existed doesn't count as "changed".
    const norm = (v: unknown) => (u === "notify.ntfyUrl" ? normaliseNtfy(String(v ?? "")) : String(v ?? "").replace(/\/+$/, ""));
    if (keptOld && norm(getPath(next, u)) !== norm(getPath(cur, u))) setPath(next as unknown as Record<string, unknown>, k, "");
  }
  next.externalUrl = next.externalUrl.replace(/\/+$/, "");
  write(next);
  return next;
}

/** "my-topic" or "ntfy.sh/my-topic" -> "https://ntfy.sh/my-topic". */
function normaliseNtfy(v: string) {
  const t = v.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, "");
  if (t.includes("/")) return `https://${t.replace(/\/+$/, "")}`;
  return `https://ntfy.sh/${t}`;
}

export function setBypassLocal(on: boolean) {
  write({ ...getSettings(), auth: { ...getSettings().auth, bypassLocal: on } });
}

/** Internal update that skips sanitising (server-side values such as an auto-detected key or a Plex token). */
export function patchSettings(fn: (s: Settings) => Settings) {
  write(fn(structuredClone(getSettings())));
}

export function setGenrePrefs(prefs: unknown) {
  const clean: Record<string, Pref> = {};
  if (prefs && typeof prefs === "object") {
    for (const [g, v] of Object.entries(prefs)) if (v === "love" || v === "ok" || v === "never") clean[g] = v;
  }
  write({ ...getSettings(), genrePrefs: clean });
}

export function regenerateKey(which: "apiKey" | "webhookKey") {
  const s = { ...getSettings(), [which]: rand(16) };
  write(s);
  return s[which];
}

export async function setAccount(username: string, password: string) {
  const salt = crypto.randomBytes(16);
  const hash = `${salt.toString("hex")}:${(await scrypt(password, salt, 32)).toString("hex")}`;
  const s = getSettings();
  // A new secret invalidates every existing session.
  write({ ...s, auth: { ...s.auth, username, passwordHash: hash }, secret: rand(32) });
}

export async function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = await scrypt(pw, Buffer.from(salt, "hex"), 32);
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

export function safeEqual(a: string | undefined, b: string) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
