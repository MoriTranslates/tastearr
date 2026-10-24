export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event("tastearr:logout"));
    throw new ApiError(data?.error ?? res.statusText, res.status);
  }
  return data as T;
}

export type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";

export interface Status {
  version: string;
  authRequired: boolean;
  loggedIn: boolean;
  sonarr: boolean;
  media: boolean;
  quizAnswers: number;
  profileBuiltAt: number | null;
  season: { season: Season; year: number };
}

export interface Pick {
  id: number;
  title: string;
  romaji: string | null;
  format: string | null;
  episodes: number | null;
  studio: string | null;
  cover: string | null;
  color: string | null;
  siteUrl: string;
  description: string | null;
  genres: string[];
  popularity: number;
  averageScore: number | null;
  score: number;
  match: number;
  reasons: { label: string; lift: number }[];
  warnings: { label: string; lift: number }[];
  similar: string | null;
  excluded: string | null;
  tvdbId: number | null;
  tvdbSeason: number | null;
  inLibrary: boolean;
  seasonMonitored: boolean | null;
  verdict: string | null;
}

export interface Profile {
  builtAt: number;
  trainedOn: number;
  positives: number;
  features: Record<string, { lift: number; n: number; p: number }>;
  favourites: { id: number; title: string }[];
  sources: Record<string, string>;
}

export interface Show {
  tvdbId: number;
  title: string;
  poster: string | null;
  monitored: boolean;
  nextAiring: string | null;
  downloaded: number;
  watched: number | null;
  total: number | null;
  dropped: boolean;
}

export type Pref = "love" | "ok" | "never";

export interface Settings {
  sonarr: { url: string; apiKey: string; qualityProfileId: number | null; rootFolderPath: string; tags: number[]; sequelMonitor: "newSeason" | "all"; searchOnAdd: boolean; dropAction: "unmonitor" | "keep" };
  media: { type: "none" | "plex" | "jellyfin"; url: string; token: string; userId: string; libraryIds: string[] };
  training: { seasons: number; minTagRank: number; formats: string[]; countries: string[] };
  filters: { excludeGenres: string[]; excludeTags: string[]; hideInLibrary: boolean };
  genrePrefs: Record<string, Pref>;
  notify: { discordWebhook: string; ntfyUrl: string; ntfyToken: string; gotifyUrl: string; gotifyToken: string; picks: number; seasonAlerts: boolean; episodeAlerts: boolean };
  externalUrl: string;
  auth: { enabled: boolean; username: string; passwordHash: string; bypassLocal: boolean };
  apiKey: string;
}

export const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const seasonName = (s: Season) => s[0] + s.slice(1).toLowerCase();
export function shiftSeason(s: { season: Season; year: number }, by: number) {
  const idx = s.year * 4 + SEASONS.indexOf(s.season) + by;
  return { season: SEASONS[((idx % 4) + 4) % 4], year: Math.floor(idx / 4) };
}
