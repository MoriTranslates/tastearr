import type { ArrConn } from "../adapters/arr.js";
import * as radarr from "../adapters/radarr.js";
import type { RadarrMovie } from "../adapters/radarr.js";
import { fail } from "../core/errors.js";
import { getSettings } from "./settings.js";

/** The user's Radarr: the movie library (cached a few minutes) and adding anime films. */

export type { RadarrMovie };

export const testRadarr = (conn: ArrConn) => radarr.status(conn);
export const radarrOptions = (conn: ArrConn = getSettings().radarr) => radarr.options(conn);

let cache: { at: number; list: RadarrMovie[] } | null = null;

export async function radarrMovies(force = false): Promise<RadarrMovie[]> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.list;
  const list = await radarr.allMovies(getSettings().radarr);
  cache = { at: Date.now(), list };
  return list;
}

/**
 * Adds a movie by TMDB id, or by IMDb id when the community mapping has no TMDB id for it. `search` overrides the
 * Radarr "search on add" setting (auto-add passes its own switch, as it does for Sonarr).
 */
export async function addMovie(ids: { tmdbId?: number | null; imdbId?: string | null }, opts: { search?: boolean } = {}) {
  const cfg = getSettings().radarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw fail("Pick a Radarr quality profile and root folder in Settings first", 400);
  const m = ids.tmdbId
    ? await radarr.lookupTmdb(cfg, ids.tmdbId)
    : ids.imdbId && /^tt\d+$/.test(ids.imdbId)
      ? await radarr.lookupImdb(cfg, ids.imdbId)
      : null;
  if (!m?.tmdbId) throw fail("Radarr couldn't find this movie", 404);
  // Idempotent: Radarr's lookup gives a library movie its id, so a retry reports it instead of failing.
  if (m.id) return { id: m.id, title: m.title, alreadyAdded: true };
  let tag: number | null = null;
  try {
    tag = await radarr.ensureTag(cfg);
  } catch {
    /* tagging is best-effort: the movie is still added, just without the "tastearr" tag */
  }
  let added: RadarrMovie;
  try {
    added = await radarr.addMovie(cfg, {
      ...m,
      qualityProfileId: cfg.qualityProfileId,
      rootFolderPath: cfg.rootFolderPath,
      minimumAvailability: cfg.minimumAvailability,
      monitored: true,
      tags: [...new Set([...cfg.tags, ...(tag ? [tag] : [])])],
      addOptions: { searchForMovie: opts.search ?? cfg.searchOnAdd },
    });
  } catch (e) {
    // A timed-out answer or a lost race: if the movie is in Radarr now, the add happened.
    const there = await radarr.movieByTmdb(cfg, m.tmdbId).catch(() => null);
    if (!there) throw e;
    added = there;
  } finally {
    cache = null;
  }
  return { id: added.id, title: added.title, alreadyAdded: false };
}
