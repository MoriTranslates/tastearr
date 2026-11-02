import * as anilist from "../adapters/anilist.js";
import { seasonOf, SEASONS, type Media, type Season } from "../core/taste/media.js";
import { cachedMedia, cachedMediaMany, cachedSeason, replaceSeason, seasonFetchedAt, storeMedia } from "../data/media.js";

/** AniList entries through the local cache: season line-ups and entries by id are only fetched when stale or missing. */

export { cachedMedia };

/** Season list from cache, refreshed if stale (current/upcoming: 12 hours, past: 30 days). */
export async function getSeason(season: Season, year: number, force = false): Promise<Media[]> {
  const fetchedAt = seasonFetchedAt(season, year);
  const cur = seasonOf();
  const past = year * 4 + SEASONS.indexOf(season) < cur.year * 4 + SEASONS.indexOf(cur.season);
  const maxAge = past ? 30 * 86_400_000 : 12 * 3_600_000;
  if (!force && fetchedAt !== undefined && Date.now() - fetchedAt <= maxAge) {
    const list = cachedSeason(season, year);
    if (list.every(Boolean)) return list as Media[];
  }
  const fresh = await anilist.fetchSeason(season, year);
  replaceSeason(fresh, season, year);
  return fresh;
}

/** Fetches (and caches) media by id: quiz shows, list imports, prequels, feedback targets. */
export async function getMediaByIds(ids: number[]): Promise<Media[]> {
  const have = cachedMediaMany(new Set(ids));
  const missing = [...new Set(ids)].filter((id) => !have.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const got = await anilist.fetchByIds(missing.slice(i, i + 50));
    storeMedia(got, null, null);
    for (const m of got) have.set(m.id, m);
  }
  return ids.map((id) => have.get(id)).filter((m): m is Media => !!m);
}

/** Title search, for the quiz's "add a show you've seen". */
export async function searchTitle(q: string): Promise<Media[]> {
  const found = await anilist.searchTitle(q);
  storeMedia(found, null, null);
  return found;
}
