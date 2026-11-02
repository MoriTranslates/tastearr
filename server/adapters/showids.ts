/**
 * Turning a media server's show ids into a TVDB id. Plex and Jellyfin file a show under whichever agent matched it:
 * TVDB directly, or only TMDB / IMDb / AniDB / AniList ids. Shows without a TVDB id are looked up in the community
 * anime list's other columns, so their watch history isn't silently dropped.
 */

export interface ShowIdTables {
  anidb: Map<number, number>;
  tmdb: Map<number, number>;
  imdb: Map<string, number>;
  anilist: Map<number, number>;
}

export interface ShowIds {
  tvdb?: string | number | null;
  tmdb?: string | number | null;
  imdb?: string | null;
  anidb?: string | number | null;
  anilist?: string | number | null;
}

const num = (v: string | number | null | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * Several library entries can land on one TVDB id (HAMA files each season separately; a show matched by TMDB next to
 * its TVDB twin). Keep the one with the most watched episodes, so an unwatched duplicate never hides watch history.
 * Returns whether `state` was kept.
 */
export function keepMostWatched<S extends { watched: number }>(out: Map<number, S>, tvdb: number, state: S): boolean {
  const have = out.get(tvdb);
  if (have && have.watched >= state.watched) return false;
  out.set(tvdb, state);
  return true;
}

/** The TVDB id, from the show's own TVDB id first, then TMDB, IMDb, AniDB and AniList through the mapping list. */
export function tvdbFromIds(ids: ShowIds, t: ShowIdTables): number {
  return (
    num(ids.tvdb) ||
    t.tmdb.get(num(ids.tmdb)) ||
    (ids.imdb && /^tt\d+$/.test(ids.imdb) ? t.imdb.get(ids.imdb) : 0) ||
    t.anidb.get(num(ids.anidb)) ||
    t.anilist.get(num(ids.anilist)) ||
    0
  );
}
