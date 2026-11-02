import { seasonIdx, seasonOf, type Media, type MediaLookup } from "./media.js";
import type { Ctx, Label, LibrarySeries } from "./types.js";

/** Whether the user has (or wants) a given TVDB season: monitored or has files. Null if Sonarr doesn't list it. */
export function seasonOwned(s: LibrarySeries, season: number | null) {
  if (season === null) return s.seasons.some((x) => x.seasonNumber > 0 && (x.monitored || (x.statistics?.episodeFileCount ?? 0) > 0));
  const x = s.seasons.find((y) => y.seasonNumber === season);
  if (!x) return null;
  return x.monitored || (x.statistics?.episodeFileCount ?? 0) > 0;
}

/** Finished airing more than about two seasons ago. */
function finishedLongAgo(m: Media | null) {
  if (!m || m.status !== "FINISHED" || !m.seasonYear || !m.season) return false;
  return seasonIdx(seasonOf()) - seasonIdx({ season: m.season, year: m.seasonYear }) >= 2;
}

/** The user chose this exact entry: its TVDB season is monitored or downloaded in Sonarr, or the movie is in Radarr. */
export function chose(id: number, ctx: Ctx) {
  const map = ctx.byAnilist.get(id);
  const s = map ? ctx.lib.get(map.tvdbId) : undefined;
  if (s) {
    const real = s.seasons.filter((x) => x.seasonNumber > 0).length;
    if (seasonOwned(s, map!.season ?? (real <= 1 ? null : -1))) return true;
  }
  const tmdb = ctx.movieByAnilist.get(id);
  return !!(tmdb && ctx.movies.has(tmdb));
}

/** Like chose(), but only when the season has files: Sonarr auto-monitors new seasons of owned series. */
export function choseWithFiles(id: number, ctx: Ctx) {
  const map = ctx.byAnilist.get(id);
  const s = map ? ctx.lib.get(map.tvdbId) : undefined;
  if (s) {
    const seasons =
      map!.season !== null ? s.seasons.filter((x) => x.seasonNumber === map!.season) : s.seasons.filter((x) => x.seasonNumber > 0);
    if (seasons.some((x) => (x.statistics?.episodeFileCount ?? 0) > 0)) return true;
  }
  const tmdb = ctx.movieByAnilist.get(id);
  return !!(tmdb && ctx.movies.get(tmdb)?.hasFile);
}

/** What we know about the user and one AniList entry, at TVDB-season level where possible. */
export function labelOf(id: number, ctx: Ctx, lookup: MediaLookup): Label {
  let n = 1;
  let p = 0;
  let fav = false;
  let known = false;
  const map = ctx.byAnilist.get(id);
  const tvdb = map?.tvdbId;
  const season = map?.season ?? null;
  const media = lookup(id);

  // Sonarr / Radarr: did they pick it?
  const s = tvdb ? ctx.lib.get(tvdb) : undefined;
  let seasonFiles = 0;
  if (s) {
    const realSeasons = s.seasons.filter((x) => x.seasonNumber > 0).length;
    if (seasonOwned(s, season ?? (realSeasons <= 1 ? null : -1))) [p, known] = [1, true];
    seasonFiles = (season !== null ? s.seasons.find((x) => x.seasonNumber === season)?.statistics?.episodeFileCount : undefined) ?? 0;
  }
  const tmdb = ctx.movieByAnilist.get(id);
  const mv = tmdb ? ctx.movies.get(tmdb) : undefined;
  if (mv) [p, known] = [mv.hasFile ? 1.2 : 1, true];

  // Media server: how far did they get? (Plex/Jellyfin are the most reliable signal.)
  let watchKnown = false;
  const w = tvdb ? ctx.watch.get(tvdb) : undefined;
  if (w) {
    let sw = season !== null ? w.seasons.get(season) : w.seasons.size <= 1 ? { watched: w.watched, total: w.total } : undefined;
    // Nothing watched in the whole series: per-season detail isn't fetched, so use Sonarr's file count for the season.
    if (!sw && w.watched === 0 && seasonFiles > 0) sw = { watched: 0, total: seasonFiles };
    if (sw && sw.total > 0) {
      const frac = sw.watched / sw.total;
      if (sw.watched >= 3 || frac >= 0.5) [p, fav, known, watchKnown] = [Math.max(p, 1.5 + frac), frac >= 0.5, true, true];
      else if (sw.watched >= 1 && sw.total >= 6 && frac < 0.25) [p, known, watchKnown] = [Math.min(p, 0.3), true, true];
      // Downloaded but never started, long after it finished airing: lukewarm. Recent shows just haven't been watched yet.
      else if (sw.watched === 0 && p === 1 && sw.total >= 3 && finishedLongAgo(media)) p = 0.6;
    }
    if (w.rating !== null && w.rating > 0) {
      if (w.rating >= 8) [p, fav, known, watchKnown] = [Math.max(p, 2.5), true, true, true];
      else if (w.rating <= 4) [p, fav, known, watchKnown] = [0.2, false, true, true];
    }
  }

  // AniList / MAL list. An unscored list is treated as weaker evidence, and never overrides what Plex saw.
  const e = ctx.lists.get(id);
  if (e && !watchKnown) {
    known = true;
    const sc = e.score && e.score > 0 ? e.score : null;
    const eps = media?.episodes ?? null;
    const frac = e.progress && eps ? e.progress / eps : 0;
    switch (e.status) {
      case "COMPLETED":
      case "REPEATING":
        if (sc !== null && sc < 50) [p, fav] = [0.3, false];
        else [p, fav] = [Math.max(p, sc === null ? 2 : sc >= 70 ? 1.5 + (sc - 50) / 40 : 1.2), sc === null || sc >= 70];
        break;
      case "CURRENT":
        p = Math.max(p, (e.progress ?? 0) >= 3 ? 1.6 : 1);
        break;
      case "PLANNING":
        if (p < 0.8) [p, n] = [0.8, 0.5];
        break;
      case "PAUSED":
        p = (e.progress ?? 0) >= 3 ? Math.max(p, 1) : Math.max(Math.min(p, 0.3), p >= 1 ? p : 0);
        break;
      case "DROPPED":
        // Sync tools often mark nearly-finished shows "dropped" when the last episode wasn't scrobbled.
        if (frac >= 0.75) [p, fav] = [Math.max(p, 1.8), true];
        else if ((e.progress ?? 0) >= 3) [p, n] = [Math.max(p, 1), 0.5];
        else if (p < 1) [p, n] = [ctx.listScored ? 0 : 0.3, ctx.listScored ? 1.5 : 1];
        break;
    }
  }

  // Explicit signals win.
  if (tvdb && ctx.dropped.has(tvdb)) return { n: 1.5, p: 0.2, fav: false, known: true };
  if (ctx.following.has(id)) [p, known] = [Math.max(p, 1.5), true];
  switch (ctx.fb.get(id)) {
    case "loved":
      return { n: 1, p: 3, fav: true, known: true };
    case "liked":
      return { n: 1, p: 2, fav: true, known: true };
    case "added":
      return { n, p: Math.max(p, 1.5), fav, known: true };
    case "meh":
      return { n: 1, p: 0.3, fav: false, known: true };
    case "hidden":
      return { n: 1, p: Math.min(p, 0.2), fav: false, known: true };
    case "disliked":
      return { n: 2, p: 0, fav: false, known: true };
  }
  return { n, p, fav, known };
}
