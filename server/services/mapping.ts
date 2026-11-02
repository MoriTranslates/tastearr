import fs from "node:fs";
import path from "node:path";
import { animeListAge, downloadAnimeList, readAnimeList } from "../adapters/animelists.js";
import { CONFIG_DIR } from "../config.js";
import type { ShowIdTables } from "../adapters/showids.js";
import { buildTables, isFirstOfMany, place, type AnimeListRow, type MappingTables } from "../core/mapping.js";
import type { Mapping } from "../core/taste/types.js";
import { clearMappingOverrides, mappingOverrides, saveMappingOverride } from "../data/mapping.js";
import { getMediaByIds } from "./catalog.js";

/**
 * AniList -> TVDB/TMDB mapping: the community list (refreshed weekly, loaded once and shared by concurrent callers),
 * user-confirmed overrides from the database, and in-memory guesses for new seasons the list hasn't caught up with.
 */

const FILE = path.join(CONFIG_DIR, "anime-list-full.json");
const MAX_AGE = 7 * 86_400_000;

/**
 * After a failed refresh (download or reload) the last good tables stay in use and the refresh is tried again after
 * `firstMs`, doubling each time up to `maxMs`, instead of a week later. Tests shrink these.
 */
export const MAPPING_RETRY = { firstMs: 30 * 60_000, maxMs: 12 * 3_600_000 };

let tables: MappingTables | null = null;
let showIds: ShowIdTables = { anidb: new Map(), tmdb: new Map(), imdb: new Map(), anilist: new Map() };
/** When the next refresh is due (MAX_AGE after a good one, sooner after a failure). */
let dueAt = 0;
let failures = 0;

function retryLater(why: string) {
  failures++;
  dueAt = Date.now() + Math.min(MAPPING_RETRY.maxMs, MAPPING_RETRY.firstMs * 2 ** (failures - 1));
  console.warn(`${why}; trying again at ${new Date(dueAt).toISOString()}`);
}

/** TMDB / IMDb / AniDB / AniList -> TVDB, for media-server shows matched by an agent that gives no TVDB id. */
function buildShowIds(rows: AnimeListRow[]): ShowIdTables {
  const t: ShowIdTables = { anidb: new Map(), tmdb: new Map(), imdb: new Map(), anilist: new Map() };
  for (const r of rows) {
    if (!r.tvdb_id) continue;
    const imdb = Array.isArray(r.imdb_id) ? r.imdb_id[0] : r.imdb_id;
    if (r.anidb_id && !t.anidb.has(r.anidb_id)) t.anidb.set(r.anidb_id, r.tvdb_id);
    if (r.themoviedb_id?.tv && !t.tmdb.has(r.themoviedb_id.tv)) t.tmdb.set(r.themoviedb_id.tv, r.tvdb_id);
    if (imdb && !t.imdb.has(imdb)) t.imdb.set(imdb, r.tvdb_id);
    if (r.anilist_id) t.anilist.set(r.anilist_id, r.tvdb_id);
  }
  return t;
}

async function refresh() {
  const stale = !fs.existsSync(FILE) || Date.now() - fs.statSync(FILE).mtimeMs > MAX_AGE;
  let downloadFailed: string | null = null;
  if (stale) {
    try {
      await downloadAnimeList(FILE);
    } catch (e) {
      if (!fs.existsSync(FILE)) throw new Error(`Could not download anime mapping list: ${(e as Error).message}`, { cause: e });
      downloadFailed = (e as Error).message;
    }
  }
  const overrides = mappingOverrides().map((o) => ({ anilistId: o.anilist_id, mapping: { tvdbId: o.tvdb_id, season: o.season } }));
  let rows: AnimeListRow[];
  try {
    rows = readAnimeList(FILE);
  } catch (e) {
    // A damaged local copy (disk full, a hand edit): fetch a fresh one rather than failing every lookup for a week.
    if (stale) throw new Error(`The anime mapping list is unreadable: ${(e as Error).message}`, { cause: e });
    await downloadAnimeList(FILE);
    rows = readAnimeList(FILE);
  }
  tables = buildTables(rows, overrides);
  showIds = buildShowIds(rows);
  if (downloadFailed) retryLater(`Mapping list refresh failed, using the cached copy (${downloadFailed})`);
  else {
    failures = 0;
    dueAt = Date.now() + MAX_AGE;
  }
}

/**
 * One load at a time: requests arriving together (first page load, a stale list) share it instead of each downloading.
 * A failed refresh keeps the tables already loaded (only the very first load can fail a lookup).
 */
let loading: Promise<void> | null = null;
async function ensure(): Promise<MappingTables> {
  if (!tables || Date.now() >= dueAt) {
    loading ??= refresh()
      .catch((e: unknown) => {
        if (!tables) throw e;
        retryLater(`Mapping list refresh failed, keeping the loaded one (${(e as Error).message})`);
      })
      .finally(() => (loading = null));
    await loading;
  }
  return tables!;
}

export async function saveOverride(anilistId: number, tvdbId: number, season: number | null) {
  const t = await ensure();
  saveMappingOverride(anilistId, tvdbId, season);
  inferred.delete(anilistId);
  place(t, anilistId, { tvdbId, season });
}

/** Forgets every user-confirmed match (Settings -> "Reset show matches"); the community list applies again. */
export function clearOverrides() {
  const n = clearMappingOverrides();
  dueAt = 0;
  return n;
}

/**
 * Matches guessed from an earlier season when the community list hasn't caught up (a new season of a show already
 * in Sonarr). Kept in memory only; recomputed on every picks load.
 */
const inferred = new Map<number, Mapping>();
export function setInferred(anilistId: number, m: Mapping) {
  inferred.set(anilistId, m);
}
/** A show whose guess no longer holds (library changed) loses it; other seasons' guesses stay valid. */
export function dropInferred(anilistId: number) {
  inferred.delete(anilistId);
}

/** When the community list was last downloaded (System -> Health). */
export function mappingFileAge() {
  return animeListAge(FILE);
}

export async function mapAnilist(id: number): Promise<Mapping | null> {
  return (await ensure()).byAnilist.get(id) ?? inferred.get(id) ?? null;
}

export async function anilistIdsForTvdb(tvdbId: number): Promise<number[]> {
  return (await ensure()).byTvdb.get(tvdbId) ?? [];
}

export async function mappingTables(): Promise<MappingTables> {
  return ensure();
}

export async function showIdTables(): Promise<ShowIdTables> {
  await ensure();
  return showIds;
}

/** Long-runners that TVDB files as one big "season 1" (several AniList entries map there): never grab it all. */
export async function firstOfMany(map: { tvdbId: number; season: number | null }) {
  if (map.season !== 1) return false;
  const t = await mappingTables();
  const ids = (t.byTvdb.get(map.tvdbId) ?? []).filter((x) => t.byAnilist.get(x)?.season === 1);
  if (ids.length < 2) return false;
  return isFirstOfMany(await getMediaByIds(ids));
}
