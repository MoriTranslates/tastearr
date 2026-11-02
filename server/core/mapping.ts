import type { Mapping } from "./taste/types.js";

/**
 * ID tables from the community-maintained Fribb/anime-lists file: AniList <-> TVDB (series and season), MAL, TMDB,
 * IMDb and AniDB. Pure: the file is downloaded and read by the mapping service.
 */

/** One row of anime-list-full.json (only the fields used). */
export interface AnimeListRow {
  anilist_id?: number;
  tvdb_id?: number;
  mal_id?: number;
  anidb_id?: number;
  imdb_id?: string[] | string;
  themoviedb_id?: { movie?: number[] | number; tv?: number };
  season?: { tvdb?: number };
}

export interface MappingTables {
  byAnilist: Map<number, Mapping>;
  byTvdb: Map<number, number[]>;
  byMal: Map<number, number>;
  /** AniList id -> TMDB movie id (for Radarr). */
  movieByAnilist: Map<number, number>;
  anilistByMovie: Map<number, number[]>;
  /** AniList id -> IMDb id, for movies without a TMDB id (Radarr can look those up too). */
  imdbByAnilist: Map<number, string>;
  /** AniDB id -> TVDB id, for Plex libraries using the HAMA agent. */
  tvdbByAnidb: Map<number, number>;
}

function push(m: Map<number, number[]>, k: number, v: number) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Builds the tables; user-confirmed `overrides` win over the community list. */
export function buildTables(rows: AnimeListRow[], overrides: { anilistId: number; mapping: Mapping }[]): MappingTables {
  const t: MappingTables = {
    byAnilist: new Map(),
    byTvdb: new Map(),
    byMal: new Map(),
    movieByAnilist: new Map(),
    anilistByMovie: new Map(),
    imdbByAnilist: new Map(),
    tvdbByAnidb: new Map(),
  };
  for (const r of rows) {
    const imdb = Array.isArray(r.imdb_id) ? r.imdb_id[0] : r.imdb_id;
    if (r.anilist_id && imdb) t.imdbByAnilist.set(r.anilist_id, imdb);
    if (r.anidb_id && r.tvdb_id && !t.tvdbByAnidb.has(r.anidb_id)) t.tvdbByAnidb.set(r.anidb_id, r.tvdb_id);
    if (r.anilist_id && r.mal_id) t.byMal.set(r.mal_id, r.anilist_id);
    const mv = r.themoviedb_id?.movie;
    const movie = Array.isArray(mv) ? mv[0] : mv;
    if (r.anilist_id && movie) {
      t.movieByAnilist.set(r.anilist_id, movie);
      push(t.anilistByMovie, movie, r.anilist_id);
    }
    if (!r.anilist_id || !r.tvdb_id) continue;
    const mapping = { tvdbId: r.tvdb_id, season: r.season?.tvdb ?? null };
    // An AniList id listed twice (the last row wins) must leave the first series' list, and appear only once in each.
    if (t.byAnilist.has(r.anilist_id)) place(t, r.anilist_id, mapping);
    else {
      t.byAnilist.set(r.anilist_id, mapping);
      push(t.byTvdb, r.tvdb_id, r.anilist_id);
    }
  }
  for (const o of overrides) place(t, o.anilistId, o.mapping);
  return t;
}

/** Points an AniList id at a TVDB series, taking it out of the previous series' list so watch history doesn't mix. */
export function place(t: MappingTables, anilistId: number, m: Mapping) {
  const old = t.byAnilist.get(anilistId);
  if (old && old.tvdbId !== m.tvdbId)
    t.byTvdb.set(
      old.tvdbId,
      (t.byTvdb.get(old.tvdbId) ?? []).filter((x) => x !== anilistId),
    );
  t.byAnilist.set(anilistId, m);
  t.byTvdb.set(m.tvdbId, [...new Set([...(t.byTvdb.get(m.tvdbId) ?? []), anilistId])]);
}

/**
 * Long-runners that TVDB files as one big "season 1": among the AniList entries mapped to that season, one runs past
 * 50 episodes, or they span three years or more. Never grab all of it.
 */
export function isFirstOfMany(entries: { episodes: number | null; seasonYear: number | null; startDate?: { year: number | null } }[]) {
  const years = entries.map((x) => x.seasonYear ?? x.startDate?.year ?? 0).filter(Boolean);
  return entries.some((x) => (x.episodes ?? 0) > 50) || (years.length > 1 && Math.max(...years) - Math.min(...years) >= 3);
}
