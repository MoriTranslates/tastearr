export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-Tastearr"] = "1"; // CSRF guard: cross-site forms can't set custom headers
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
    signal: opts.signal,
  });
  const text = await res.text();
  let data: Record<string, unknown> | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("tastearr:auth"));
    throw new ApiError((data?.error as string) ?? res.statusText, res.status, data);
  }
  return data as T;
}

export type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";
export type Section = "continuing" | "new" | "shorts" | "movies";

export interface Status {
  version: string;
  setupRequired: boolean;
  loggedIn: boolean;
  via?: "session" | "local" | "apikey";
  sonarr?: boolean;
  radarr?: boolean;
  media?: boolean;
  lists?: boolean;
  quizAnswers?: number;
  profileBuiltAt?: number | null;
  building?: boolean;
  prefs?: { hideInLibrary: boolean; hideShorts: boolean; services: string[]; dropAction: "unmonitor" | "keep" };
  warnings?: string[];
  alerts?: boolean;
  mode?: "server" | "stream" | "";
  season?: { season: Season; year: number };
}

export interface Pick {
  id: number;
  title: string;
  altTitle: string | null;
  section: Section;
  carryOver: boolean;
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  studio: string | null;
  source: string | null;
  startDate: string | null;
  nextAiring: { at: number; episode: number } | null;
  streaming: { site: string; url: string }[];
  trailer: string | null;
  cover: string | null;
  color: string | null;
  siteUrl: string;
  description: string | null;
  genres: string[];
  popularity: number;
  averageScore: number | null;
  score: number;
  match: number;
  lowConfidence: boolean;
  continues: { title: string; watched: boolean; kept: boolean; behind: number } | null;
  spinOffOf: string | null;
  compilationOf: { title: string; seen: boolean } | null;
  matchGuessed: boolean;
  myStatus: "watching" | "seen" | "planning" | "following" | "dropped" | null;
  needsMatch: boolean;
  reasons: { label: string; lift: number }[];
  warnings: { label: string; lift: number }[];
  similar: string | null;
  excluded: string | null;
  tvdbId: number | null;
  tvdbSeason: number | null;
  tmdbId: number | null;
  inLibrary: boolean;
  seasonMonitored: boolean | null;
  addVia: "sonarr" | "radarr" | null;
  cantAdd: string | null;
  verdict: string | null;
  following: boolean;
}

export interface Profile {
  builtAt: number;
  trainedOn: number;
  positives: number;
  known: number;
  features: Record<string, { lift: number; n: number; p: number }>;
  favourites: { id: number; title: string }[];
  sources: Record<string, string>;
  building?: boolean;
}

export interface Show {
  tvdbId: number;
  title: string;
  poster: string | null;
  monitored: boolean | null;
  nextAiring: string | null;
  downloaded: number;
  watched: number | null;
  total: number | null;
  dropped: boolean;
}

export interface Followed {
  id: number;
  title: string;
  cover: string | null;
  siteUrl: string;
  status: string | null;
  episodes: number | null;
  nextAiring: { at: number; episode: number } | null;
  streaming: { site: string; url: string }[];
}

export interface Job { name: string; state: "running" | "done" | "error"; detail: string; startedAt: number | null; finishedAt: number | null }

export type Pref = "love" | "ok" | "never";

export interface ArrSettings { url: string; apiKey: string; qualityProfileId: number | null; rootFolderPath: string; tags: number[]; searchOnAdd: boolean }

export interface Settings {
  sonarr: ArrSettings & { sequelMonitor: "newSeason" | "all"; dropAction: "unmonitor" | "keep" };
  radarr: ArrSettings & { minimumAvailability: "announced" | "inCinemas" | "released" };
  media: { type: "none" | "plex" | "jellyfin"; url: string; token: string; userId: string; libraryIds: string[] };
  lists: { anilistUser: string; malUser: string; malClientId: string };
  training: { seasons: number; minTagRank: number; formats: string[]; countries: string[] };
  filters: { excludeGenres: string[]; excludeTags: string[]; hideInLibrary: boolean; hideShorts: boolean; noGore: boolean };
  display: { titleLanguage: "english" | "romaji" | "native"; services: string[] };
  sonarrExtra: { name: string; url: string; apiKey: string }[];
  autoAdd: { enabled: boolean; minMatch: number; newShows: boolean; sequels: boolean; movies: boolean; maxPerSeason: number; search: boolean };
  mode: "server" | "stream" | "";
  genrePrefs: Record<string, Pref>;
  notify: { discordWebhook: string; ntfyUrl: string; ntfyToken: string; gotifyUrl: string; gotifyToken: string; picks: number; seasonAlerts: boolean; episodeAlerts: boolean; airingAlerts: boolean; airingDelayMin: number };
  externalUrl: string;
  auth: { username: string; hasPassword: boolean; bypassLocal: boolean };
  webhookKey: string;
}

export interface AddPlan {
  app: "sonarr" | "radarr";
  needsMatch?: boolean;
  title?: string;
  year?: number | null;
  monitor?: "season" | "all" | "future" | "none";
  monitorLabel?: string;
  season?: number | null;
  seasonListed?: boolean;
  search?: boolean;
  profile?: string | null;
  rootFolder?: string;
  tags?: string[];
  options?: { value: "season" | "all" | "future" | "none"; label: string }[];
  resumesSeries?: boolean;
  alreadyInLibrary?: boolean;
  seasons?: number[];
  minimumAvailability?: string;
}

export interface Candidate { tvdbId: number; title: string; year: number | null; network: string | null; seasons: number[]; overview: string | null; inLibrary: boolean; confident: boolean }

export interface ArrOptions { profiles: { id: number; name: string }[]; roots: { id: number; path: string }[]; tags: { id: number; label: string }[] }

export const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const seasonName = (s: Season) => s[0] + s.slice(1).toLowerCase();
export function shiftSeason(s: { season: Season; year: number }, by: number) {
  const idx = s.year * 4 + SEASONS.indexOf(s.season) + by;
  return { season: SEASONS[((idx % 4) + 4) % 4], year: Math.floor(idx / 4) };
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`tastearr.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`tastearr.${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};
