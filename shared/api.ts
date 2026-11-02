/**
 * The HTTP API contract: request and response shapes used by both the server and the web UI, so a change on one side
 * that the other doesn't follow fails `npm run typecheck`. Types only: nothing here exists at runtime.
 */

export type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";
export type Section = "continuing" | "new" | "shorts" | "movies";
/** The user's own relationship with this exact entry. */
export type MyStatus = "watching" | "seen" | "planning" | "following" | "dropped" | null;
/** A quiz answer for a genre or theme. "never" excludes it outright. */
export type Pref = "love" | "ok" | "never";
export type MonitorChoice = "season" | "all" | "future" | "none";

/** GET /api/status. Only the first three fields are sent before login. */
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

/** One recommendation, as scored by the taste engine. */
export interface ScoredPick {
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
  /** Direct sequel: the previous season, whether the user watched/kept it, and how many seasons they're behind. */
  continues: { title: string; watched: boolean; kept: boolean; behind: number } | null;
  spinOffOf: string | null;
  compilationOf: { title: string; seen: boolean } | null;
  myStatus: MyStatus;
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
  /** Shown when it can't be added; null when it can (or when nothing is connected, where Follow is the action). */
  cantAdd: string | null;
  /** No TVDB match yet, but Sonarr's title search can find it (the UI offers a picker). */
  needsMatch: boolean;
  /** Matched through its earlier season in Sonarr because the community list hasn't caught up yet. */
  matchGuessed: boolean;
  verdict: string | null;
}

/** A pick as GET /api/picks sends it. */
export interface Pick extends ScoredPick {
  following: boolean;
}

/** GET /api/picks */
export interface PicksResponse {
  season: Season;
  year: number;
  picks: Pick[];
  profileBuiltAt: number;
}

export interface FeatureStat {
  lift: number;
  n: number;
  p: number;
}

/** The learned taste model (GET /api/profile). */
export interface TasteProfile {
  builtAt: number;
  trainedOn: number;
  positives: number;
  /** Shows with a real signal from the user (library, watch, list, rating), as opposed to "aired, didn't pick". */
  known: number;
  base: number;
  features: Record<string, FeatureStat>;
  /** Shows the user clearly enjoyed (one per franchise), for "like X" explanations. */
  favourites: { id: number; title: string; feats: string[] }[];
  sources: Record<string, string>;
}

/** GET /api/profile: the profile, or a note that the first one is being built. */
export type ProfileResponse = TasteProfile | { building: true };

/** A continuing series on My Shows. */
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

/** A show on the follow list (people without Sonarr). */
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

/** GET /api/shows */
export interface ShowsResponse {
  sonarr: Show[];
  following: Followed[];
}

export interface Job {
  name: string;
  state: "running" | "done" | "error";
  detail: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** The last failure, kept when a later run succeeds, so System can show when and why a job last went wrong. */
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
}

export interface ArrSettings {
  url: string;
  apiKey: string;
  qualityProfileId: number | null;
  rootFolderPath: string;
  tags: number[];
  searchOnAdd: boolean;
}

/** Settings as the browser sees them (GET/PUT /api/settings): secrets masked, hashes and signing keys removed. */
export interface PublicSettings {
  sonarr: ArrSettings & { sequelMonitor: "newSeason" | "all"; dropAction: "unmonitor" | "keep" };
  radarr: ArrSettings & { minimumAvailability: "announced" | "inCinemas" | "released" };
  media: { type: "none" | "plex" | "jellyfin"; url: string; token: string; userId: string; libraryIds: string[] };
  lists: { anilistUser: string; malUser: string; malClientId: string };
  training: { seasons: number; minTagRank: number; formats: string[]; countries: string[] };
  filters: { excludeGenres: string[]; excludeTags: string[]; hideInLibrary: boolean; hideShorts: boolean; noGore: boolean };
  display: { titleLanguage: "english" | "romaji" | "native"; services: string[] };
  sonarrExtra: { name: string; url: string; apiKey: string }[];
  autoAdd: {
    enabled: boolean;
    minMatch: number;
    newShows: boolean;
    sequels: boolean;
    movies: boolean;
    maxPerSeason: number;
    search: boolean;
  };
  mode: "server" | "stream" | "";
  genrePrefs: Record<string, Pref>;
  notify: {
    discordWebhook: string;
    ntfyUrl: string;
    ntfyToken: string;
    gotifyUrl: string;
    gotifyToken: string;
    picks: number;
    seasonAlerts: boolean;
    episodeAlerts: boolean;
    airingAlerts: boolean;
    airingDelayMin: number;
  };
  externalUrl: string;
  auth: { username: string; hasPassword: boolean; bypassLocal: boolean };
  webhookKey: string;
}

/** What "Add" will do, shown before anything is written to Sonarr/Radarr (GET /api/picks/:id/plan). */
export interface AddPlan {
  app: "sonarr" | "radarr";
  needsMatch?: boolean;
  title?: string | null;
  year?: number | null;
  monitor?: MonitorChoice;
  monitorLabel?: string;
  season?: number | null;
  seasonListed?: boolean;
  search?: boolean;
  profile?: string | null;
  rootFolder?: string;
  tags?: string[];
  options?: { value: MonitorChoice; label: string }[];
  resumesSeries?: boolean;
  alreadyInLibrary?: boolean;
  seasons?: number[];
  minimumAvailability?: string;
}

/** A Sonarr title-search result offered when the community mapping has no TVDB match (GET /api/picks/:id/candidates). */
export interface Candidate {
  tvdbId: number;
  title: string;
  year: number | null;
  network: string | null;
  seasons: number[];
  overview: string | null;
  inLibrary: boolean;
  confident: boolean;
}

/** Quality profiles, root folders and tags of a Sonarr/Radarr (part of POST /api/sonarr/test and /api/radarr/test). */
export interface ArrOptions {
  profiles: { id: number; name: string }[];
  roots: { id: number; path: string }[];
  tags: { id: number; label: string }[];
}
