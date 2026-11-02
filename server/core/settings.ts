import crypto from "node:crypto";
import type { Pref, PublicSettings } from "../../shared/api.js";
import { checkOutbound, OutboundError } from "./outbound.js";

/**
 * The settings document: its shape and defaults, and the pure rules for loading it, masking it for the browser and
 * applying an untrusted update. Storage and caching live in services/settings.ts.
 */

export type { Pref };

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
  /** Picks at or above minMatch go to Sonarr/Radarr on their own (off by default). */
  autoAdd: {
    enabled: boolean;
    minMatch: number;
    newShows: boolean;
    sequels: boolean;
    movies: boolean;
    maxPerSeason: number;
    search: boolean;
  };
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

export const DEFAULTS: Settings = {
  sonarr: {
    url: "",
    apiKey: "",
    qualityProfileId: null,
    rootFolderPath: "",
    tags: [],
    sequelMonitor: "newSeason",
    searchOnAdd: true,
    dropAction: "unmonitor",
  },
  sonarrExtra: [],
  radarr: { url: "", apiKey: "", qualityProfileId: null, rootFolderPath: "", tags: [], minimumAvailability: "released", searchOnAdd: true },
  media: { type: "none", url: "", token: "", userId: "", libraryIds: [] },
  lists: { anilistUser: "", malUser: "", malClientId: "" },
  training: { seasons: 8, minTagRank: 60, formats: ["TV", "TV_SHORT", "ONA"], countries: ["JP"] },
  filters: { excludeGenres: [], excludeTags: ["Kids"], hideInLibrary: false, hideShorts: false, noGore: false },
  display: { titleLanguage: "english", services: [] },
  autoAdd: { enabled: false, minMatch: 85, newShows: true, sequels: true, movies: false, maxPerSeason: 10, search: true },
  mode: "",
  genrePrefs: {},
  notify: {
    discordWebhook: "",
    ntfyUrl: "",
    ntfyToken: "",
    gotifyUrl: "",
    gotifyToken: "",
    picks: 10,
    seasonAlerts: true,
    episodeAlerts: true,
    airingAlerts: true,
    airingDelayMin: 60,
  },
  externalUrl: "",
  auth: { username: "", passwordHash: "", bypassLocal: false },
  apiKey: "",
  webhookKey: "",
  plexClientId: "",
  secret: "",
};

const SECRET_PATHS = [
  "sonarr.apiKey",
  "radarr.apiKey",
  "media.token",
  "notify.discordWebhook",
  "notify.ntfyToken",
  "notify.gotifyToken",
  "lists.malClientId",
] as const;
/** Settings the browser may change through PUT /api/settings. Everything else has its own endpoint. */
const EDITABLE = ["sonarr", "radarr", "media", "lists", "training", "filters", "display", "autoAdd", "notify", "externalUrl", "mode"];
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
/** Addresses Tastearr calls, checked when they change (externalUrl is only put in links, so it just needs http(s)). */
const OUTBOUND_URLS: [string, string][] = [
  ["sonarr.url", "The Sonarr address"],
  ["radarr.url", "The Radarr address"],
  ["media.url", "The media server address"],
  ["notify.discordWebhook", "The Discord webhook"],
  ["notify.ntfyUrl", "The ntfy address"],
  ["notify.gotifyUrl", "The Gotify address"],
];
const RANGES: Record<string, [number, number]> = {
  "training.seasons": [2, 24],
  "training.minTagRank": [0, 100],
  "notify.picks": [3, 30],
  "notify.airingDelayMin": [0, 1440],
  "autoAdd.minMatch": [50, 100],
  "autoAdd.maxPerSeason": [1, 50],
};

export const MASK = "••••••••";
/** True for the mask (or a mangled copy of it); real keys are printable ASCII. */
export const isMasked = (v: unknown) => typeof v === "string" && (v === MASK || /^[^ -~]+$/.test(v));

export const rand = (n: number) => crypto.randomBytes(n).toString("hex");

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
  if (path === "sonarr.qualityProfileId" || path === "radarr.qualityProfileId")
    return patch === null || patch === "" ? null : Number.isFinite(Number(patch)) ? Number(patch) : undefined;
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

/**
 * Settings from the stored JSON, with defaults for anything missing. `changed` says the result must be written back
 * (keys generated on first run, or a v0.1 document upgraded).
 */
export function loadSettings(stored: Record<string, unknown>): { settings: Settings; changed: boolean } {
  let s = merge(DEFAULTS, stored);
  // v0.1 had auth.enabled and a local bypass that defaulted on; v0.2 always requires an account.
  const legacy = !!stored.auth && "enabled" in (stored.auth as object);
  if (legacy) s = { ...s, auth: { username: s.auth.username, passwordHash: s.auth.passwordHash, bypassLocal: false } };
  const missing = !s.apiKey || !s.secret || !s.webhookKey || !s.plexClientId;
  if (missing)
    s = {
      ...s,
      apiKey: s.apiKey || rand(16),
      secret: s.secret || rand(32),
      webhookKey: s.webhookKey || rand(16),
      plexClientId: s.plexClientId || crypto.randomUUID(),
    };
  return { settings: s, changed: missing || legacy };
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
export function toPublicSettings(settings: Settings): PublicSettings {
  const s = structuredClone(settings) as unknown as Record<string, unknown>;
  for (const p of SECRET_PATHS) if (getPath(s, p)) setPath(s, p, MASK);
  const auth = s.auth as Record<string, unknown>;
  auth.hasPassword = !!auth.passwordHash;
  delete auth.passwordHash;
  s.sonarrExtra = (s.sonarrExtra as Settings["sonarrExtra"]).map((x) => ({ ...x, apiKey: MASK }));
  delete s.secret;
  delete s.apiKey;
  delete s.plexClientId;
  return s as unknown as PublicSettings;
}

/**
 * Applies an untrusted partial update from the browser to `cur` and returns the new settings. Masked secrets mean
 * "unchanged"; a secret whose address changed is dropped; changed outgoing addresses must pass the outbound check.
 */
export function applyUpdate(cur: Settings, patch: unknown): Settings {
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
  // A copy: sections the patch doesn't touch would otherwise be the caller's (cached) objects, normalised in place
  // below before a later check could still throw. Nothing reaches `cur` until the caller saves the result.
  const next = merge(structuredClone(cur), allowed) as Settings;
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
  // Only addresses that changed: an old value saved before these checks shouldn't block saving anything else.
  for (const [p, what] of OUTBOUND_URLS) {
    const v = String(getPath(next, p) ?? "");
    if (v && v !== getPath(cur, p)) checkOutbound(v, what);
  }
  if (next.externalUrl && next.externalUrl !== cur.externalUrl && !/^https?:\/\/[^/]/i.test(next.externalUrl))
    throw new OutboundError("The external address must start with http:// or https://");
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

/** Quiz genre/theme answers from the browser: only love / ok / never survive. */
export function cleanGenrePrefs(prefs: unknown): Record<string, Pref> {
  const clean: Record<string, Pref> = {};
  if (prefs && typeof prefs === "object") {
    for (const [g, v] of Object.entries(prefs)) if (v === "love" || v === "ok" || v === "never") clean[g] = v;
  }
  return clean;
}
