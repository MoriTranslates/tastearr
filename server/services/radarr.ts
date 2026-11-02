import type { ArrConn } from "../adapters/arr.js";
import * as radarr from "../adapters/radarr.js";
import type { RadarrMovie } from "../adapters/radarr.js";
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

/** Adds a movie by TMDB id, or by IMDb id when the community mapping has no TMDB id for it. */
export async function addMovie(ids: { tmdbId?: number | null; imdbId?: string | null }) {
  const cfg = getSettings().radarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw new Error("Pick a Radarr quality profile and root folder in Settings first");
  const m = ids.tmdbId
    ? await radarr.lookupTmdb(cfg, ids.tmdbId)
    : ids.imdbId && /^tt\d+$/.test(ids.imdbId)
      ? await radarr.lookupImdb(cfg, ids.imdbId)
      : null;
  if (!m?.tmdbId) throw new Error("Radarr couldn't find this movie");
  let tag: number | null = null;
  try {
    tag = await radarr.ensureTag(cfg);
  } catch {
    /* tagging is best-effort */
  }
  const added = await radarr.addMovie(cfg, {
    ...m,
    qualityProfileId: cfg.qualityProfileId,
    rootFolderPath: cfg.rootFolderPath,
    minimumAvailability: cfg.minimumAvailability,
    monitored: true,
    tags: [...new Set([...cfg.tags, ...(tag ? [tag] : [])])],
    addOptions: { searchForMovie: cfg.searchOnAdd },
  });
  cache = null;
  return { id: added.id, title: added.title };
}
