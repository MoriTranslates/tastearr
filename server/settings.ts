import crypto from "node:crypto";
import { db } from "./db.js";

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
  media: {
    type: "none" | "plex" | "jellyfin";
    url: string;
    token: string;
    /** Jellyfin/Emby user id. Unused for Plex (the token's owner is used). */
    userId: string;
    /** Library section ids (Plex) or parent ids (Jellyfin) holding anime. Empty = all show libraries. */
    libraryIds: string[];
  };
  training: { seasons: number; minTagRank: number; formats: string[]; countries: string[] };
  filters: { excludeGenres: string[]; excludeTags: string[]; hideInLibrary: boolean };
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
    episodeAlerts: boolean;
  };
  /** Address phones can reach Tastearr at, for buttons in alerts. Optional. */
  externalUrl: string;
  auth: { enabled: boolean; username: string; passwordHash: string; bypassLocal: boolean };
  apiKey: string;
  secret: string;
}

const DEFAULTS: Settings = {
  sonarr: { url: "", apiKey: "", qualityProfileId: null, rootFolderPath: "", tags: [], sequelMonitor: "newSeason", searchOnAdd: true, dropAction: "unmonitor" },
  media: { type: "none", url: "", token: "", userId: "", libraryIds: [] },
  training: { seasons: 8, minTagRank: 60, formats: ["TV", "TV_SHORT", "ONA"], countries: ["JP"] },
  filters: { excludeGenres: [], excludeTags: ["Kids"], hideInLibrary: false },
  genrePrefs: {},
  notify: { discordWebhook: "", ntfyUrl: "", ntfyToken: "", gotifyUrl: "", gotifyToken: "", picks: 10, seasonAlerts: true, episodeAlerts: true },
  externalUrl: "",
  auth: { enabled: false, username: "", passwordHash: "", bypassLocal: true },
  apiKey: "",
  secret: "",
};

const SECRET_PATHS = ["sonarr.apiKey", "media.token", "notify.discordWebhook", "notify.ntfyToken", "notify.gotifyToken"] as const;
export const MASK = "••••••••";
/** True for the mask (or a mangled copy of it): any non-printable-ASCII value can't be a real key. */
export const isMasked = (v: unknown) => typeof v === "string" && (v === MASK || /[^ -~]/.test(v));

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over) || base === null || typeof base !== "object" || Array.isArray(base)) {
    return (over === undefined ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
  let s = merge(DEFAULTS, row ? JSON.parse(row.value) : {});
  if (!s.apiKey || !s.secret) {
    s = { ...s, apiKey: s.apiKey || crypto.randomBytes(16).toString("hex"), secret: s.secret || crypto.randomBytes(32).toString("hex") };
    write(s);
  }
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

/** Settings as sent to the browser: secrets masked, password hash and signing secret removed. */
export function publicSettings() {
  const s = structuredClone(getSettings()) as unknown as Record<string, unknown>;
  for (const p of SECRET_PATHS) if (getPath(s, p)) setPath(s, p, MASK);
  delete s.secret;
  (s.auth as Record<string, unknown>).passwordHash = (s.auth as Record<string, unknown>).passwordHash ? MASK : "";
  return s;
}

/** Applies a partial update from the browser. Masked secrets mean "unchanged". */
export function updateSettings(patch: Record<string, unknown>, password?: string) {
  const cur = getSettings();
  const next = merge(cur, patch) as Settings;
  for (const p of SECRET_PATHS) if (isMasked(getPath(next, p))) setPath(next as unknown as Record<string, unknown>, p, getPath(cur, p));
  next.auth.passwordHash = password ? hashPassword(password) : cur.auth.passwordHash;
  next.secret = cur.secret;
  next.apiKey = cur.apiKey;
  next.sonarr.url = next.sonarr.url.replace(/\/+$/, "");
  next.media.url = next.media.url.replace(/\/+$/, "");
  next.externalUrl = next.externalUrl.replace(/\/+$/, "");
  write(next);
  return next;
}

export function setGenrePrefs(prefs: Record<string, Pref>) {
  write({ ...getSettings(), genrePrefs: prefs });
}

export function regenerateApiKey() {
  const s = { ...getSettings(), apiKey: crypto.randomBytes(16).toString("hex") };
  write(s);
  return s.apiKey;
}

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}

export function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, "hex"));
}
