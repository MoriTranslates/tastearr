import type { Pref } from "../../../shared/api.js";
import type { MediaLookup } from "./media.js";

/**
 * The inputs of the taste engine, as plain data. Adapters (Sonarr, Radarr, Plex/Jellyfin, AniList/MAL lists) produce
 * objects that fit these shapes; the engine never calls them itself.
 */

/** AniList entry -> TVDB series and season. */
export interface Mapping {
  tvdbId: number;
  /** TVDB season this AniList entry corresponds to, when known. */
  season: number | null;
}

export interface LibrarySeason {
  seasonNumber: number;
  monitored: boolean;
  statistics?: { episodeFileCount: number; totalEpisodeCount: number; episodeCount: number };
}

/** A series in the user's library (Sonarr). */
export interface LibrarySeries {
  id: number;
  tvdbId: number;
  title: string;
  seriesType: string;
  status: string;
  monitored: boolean;
  seasons: LibrarySeason[];
  /** Address of the Sonarr instance it lives in ("" = the main one). */
  instance?: string;
  /** First-air year, network and overview, as Sonarr's search returns them. */
  year?: number;
  network?: string;
  overview?: string;
  [k: string]: unknown;
}

/** A movie in the user's library (Radarr). */
export interface LibraryMovie {
  id: number;
  tmdbId: number;
  title: string;
  hasFile: boolean;
  monitored: boolean;
  [k: string]: unknown;
}

/** How far the user got through a show, keyed by TVDB id, with per-season detail when available. */
export interface WatchState {
  title: string;
  watched: number;
  total: number;
  seasons: Map<number, { watched: number; total: number }>;
  /** Explicit rating 0-10 (Plex userRating, Jellyfin favourite = 10), if any. */
  rating: number | null;
}

/** An AniList/MAL list entry, normalised to AniList statuses and 0-100 scores. */
export interface ListEntry {
  status: string;
  score: number | null;
  progress: number | null;
}

/** Everything known about the user, gathered once and reused for every score. */
export interface Ctx {
  lib: Map<number, LibrarySeries>;
  movies: Map<number, LibraryMovie>;
  watch: Map<number, WatchState>;
  /** Verdicts the user gave (loved, liked, meh, disliked, hidden, added), by AniList id. */
  fb: Map<number, string>;
  /** TVDB ids the user is "not into anymore". */
  dropped: Set<number>;
  lists: Map<number, ListEntry>;
  /** True when the list has scores; an unscored list that's mostly DROPPED is probably an automated sync. */
  listScored: boolean;
  following: Set<number>;
  byAnilist: Map<number, Mapping>;
  byTvdb: Map<number, number[]>;
  movieByAnilist: Map<number, number>;
  imdbByAnilist: Map<number, string>;
  /** The user has a library or history to learn from (not quiz-only). */
  hasHistory: boolean;
  sources: Record<string, string>;
}

/** The settings the engine reads. */
export interface TasteConfig {
  training: { seasons: number; minTagRank: number; formats: string[]; countries: string[] };
  filters: { excludeGenres: string[]; excludeTags: string[]; noGore: boolean };
  /** Quiz answers for genres ("Fantasy") and themes ("T:Food"). */
  genrePrefs: Record<string, Pref>;
  titleLanguage: "english" | "romaji" | "native";
  /** Sonarr / Radarr are connected (decides whether a pick can be added, and where). */
  sonarrOn: boolean;
  radarrOn: boolean;
  /** Dev-only weight overrides for `npm run eval` experiments (TASTEARR_TUNE). Empty in normal use. */
  tune: Record<string, number>;
}

/** What the engine needs besides the user context: settings and a way to read cached AniList entries. */
export interface TasteEnv {
  config: TasteConfig;
  media: MediaLookup;
}

/** What we know about the user and one entry: weight n, "kept" score p, a clear favourite, any real signal at all. */
export interface Label {
  n: number;
  p: number;
  fav: boolean;
  known: boolean;
}
