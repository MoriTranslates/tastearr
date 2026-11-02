import * as anilist from "../adapters/anilist.js";
import { seasonOf, SEASONS, type Media, type Season } from "../core/taste/media.js";
import { cachedMedia, cachedMediaMany, cachedSeason, replaceSeason, seasonFetchedAt, storeMedia } from "../data/media.js";

/** AniList entries through the local cache: season line-ups and entries by id are only fetched when stale or missing. */

export { cachedMedia };

/**
 * Season list from cache, refreshed if stale (current/upcoming: 12 hours, past: 30 days). When AniList can't be
 * reached, an older cached copy is used instead (`stale` says why); with nothing cached the error is thrown.
 */
export async function getSeasonResult(season: Season, year: number, force = false): Promise<{ list: Media[]; stale: string | null }> {
  const fetchedAt = seasonFetchedAt(season, year);
  const cur = seasonOf();
  const past = year * 4 + SEASONS.indexOf(season) < cur.year * 4 + SEASONS.indexOf(cur.season);
  const maxAge = past ? 30 * 86_400_000 : 12 * 3_600_000;
  if (!force && fetchedAt !== undefined && Date.now() - fetchedAt <= maxAge) {
    const list = cachedSeason(season, year);
    if (list.every(Boolean)) return { list: list as Media[], stale: null };
  }
  try {
    const fresh = await anilist.fetchSeason(season, year);
    replaceSeason(fresh, season, year);
    return { list: fresh, stale: null };
  } catch (e) {
    const old = fetchedAt === undefined ? [] : cachedSeason(season, year).filter((m): m is Media => !!m);
    if (!old.length) throw e;
    const why = `${season.toLowerCase()} ${year}: AniList unavailable, using the copy from ${new Date(fetchedAt!).toISOString().slice(0, 10)} (${(e as Error).message})`;
    console.warn(`Season ${why}`);
    return { list: old, stale: why };
  }
}

export async function getSeason(season: Season, year: number, force = false): Promise<Media[]> {
  return (await getSeasonResult(season, year, force)).list;
}

/**
 * Fetches (and caches) media by id, 50 per request. Without `partial`, any failed request throws. With it, failed
 * batches are skipped and their ids returned in `failed`, so one AniList hiccup doesn't lose every other batch.
 */
export async function getMediaByIdsResult(
  ids: number[],
  partial = false,
): Promise<{ media: Media[]; failed: number[]; error: string | null }> {
  const have = cachedMediaMany(new Set(ids));
  const missing = [...new Set(ids)].filter((id) => !have.has(id));
  const failed: number[] = [];
  let error: string | null = null;
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      const got = await anilist.fetchByIds(batch);
      storeMedia(got, null, null);
      for (const m of got) have.set(m.id, m);
    } catch (e) {
      if (!partial) throw e;
      failed.push(...batch);
      error = (e as Error).message;
    }
  }
  return { media: ids.map((id) => have.get(id)).filter((m): m is Media => !!m), failed, error };
}

/** Fetches (and caches) media by id: quiz shows, list imports, prequels, feedback targets. */
export async function getMediaByIds(ids: number[]): Promise<Media[]> {
  return (await getMediaByIdsResult(ids)).media;
}

/** Title search, for the quiz's "add a show you've seen". */
export async function searchTitle(q: string): Promise<Media[]> {
  const found = await anilist.searchTitle(q);
  storeMedia(found, null, null);
  return found;
}
