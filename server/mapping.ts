import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, db } from "./db.js";

/** AniList -> TVDB mapping from the community-maintained Fribb/anime-lists project. */
const URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
const FILE = path.join(CONFIG_DIR, "anime-list-full.json");
const MAX_AGE = 7 * 86_400_000;

export interface Mapping {
  tvdbId: number;
  /** TVDB season this AniList entry corresponds to, when known. */
  season: number | null;
}

let byAnilist: Map<number, Mapping> | null = null;
let byTvdb: Map<number, number[]> | null = null;
let byMal: Map<number, number> | null = null;
/** AniList id -> TMDB movie id (for Radarr). */
let movieByAnilist: Map<number, number> | null = null;
/** AniList id -> IMDb id, for movies without a TMDB id (Radarr can look those up too). */
let imdbByAnilist: Map<number, string> | null = null;
/** AniDB id -> TVDB id, for Plex libraries using the HAMA agent. */
let tvdbByAnidb: Map<number, number> | null = null;
let anilistByMovie: Map<number, number[]> | null = null;
let loadedAt = 0;

async function refresh() {
  const stale = !fs.existsSync(FILE) || Date.now() - fs.statSync(FILE).mtimeMs > MAX_AGE;
  if (stale) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(FILE + ".tmp", Buffer.from(await res.arrayBuffer()));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (e) {
      if (!fs.existsSync(FILE)) throw new Error(`Could not download anime mapping list: ${(e as Error).message}`);
      console.warn("Mapping list refresh failed, using cached copy:", (e as Error).message);
    }
  }
  const rows = JSON.parse(fs.readFileSync(FILE, "utf8")) as { anilist_id?: number; tvdb_id?: number; mal_id?: number; anidb_id?: number; imdb_id?: string[] | string; themoviedb_id?: { movie?: number[] | number; tv?: number }; season?: { tvdb?: number } }[];
  byAnilist = new Map();
  byTvdb = new Map();
  byMal = new Map();
  movieByAnilist = new Map();
  anilistByMovie = new Map();
  imdbByAnilist = new Map();
  tvdbByAnidb = new Map();
  for (const r of rows) {
    const imdb = Array.isArray(r.imdb_id) ? r.imdb_id[0] : r.imdb_id;
    if (r.anilist_id && imdb) imdbByAnilist.set(r.anilist_id, imdb);
    if (r.anidb_id && r.tvdb_id && !tvdbByAnidb.has(r.anidb_id)) tvdbByAnidb.set(r.anidb_id, r.tvdb_id);
    if (r.anilist_id && r.mal_id) byMal.set(r.mal_id, r.anilist_id);
    const mv = r.themoviedb_id?.movie;
    const movie = Array.isArray(mv) ? mv[0] : mv;
    if (r.anilist_id && movie) {
      movieByAnilist.set(r.anilist_id, movie);
      anilistByMovie.set(movie, [...(anilistByMovie.get(movie) ?? []), r.anilist_id]);
    }
    if (!r.anilist_id || !r.tvdb_id) continue;
    byAnilist.set(r.anilist_id, { tvdbId: r.tvdb_id, season: r.season?.tvdb ?? null });
    byTvdb.set(r.tvdb_id, [...(byTvdb.get(r.tvdb_id) ?? []), r.anilist_id]);
  }
  // User-confirmed matches win over the community list.
  for (const o of db.prepare("SELECT anilist_id, tvdb_id, season FROM mapping_overrides").all() as { anilist_id: number; tvdb_id: number; season: number | null }[]) {
    byAnilist.set(o.anilist_id, { tvdbId: o.tvdb_id, season: o.season });
    byTvdb.set(o.tvdb_id, [...new Set([...(byTvdb.get(o.tvdb_id) ?? []), o.anilist_id])]);
  }
  loadedAt = Date.now();
}

export function saveOverride(anilistId: number, tvdbId: number, season: number | null) {
  db.prepare("INSERT INTO mapping_overrides (anilist_id, tvdb_id, season, at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET tvdb_id = excluded.tvdb_id, season = excluded.season, at = excluded.at").run(anilistId, tvdbId, season, Date.now());
  byAnilist?.set(anilistId, { tvdbId, season });
  byTvdb?.set(tvdbId, [...new Set([...(byTvdb?.get(tvdbId) ?? []), anilistId])]);
}

async function ensure() {
  if (!byAnilist || Date.now() - loadedAt > MAX_AGE) await refresh();
}

export async function mapAnilist(id: number): Promise<Mapping | null> {
  await ensure();
  return byAnilist!.get(id) ?? null;
}

export async function anilistIdsForTvdb(tvdbId: number): Promise<number[]> {
  await ensure();
  return byTvdb!.get(tvdbId) ?? [];
}

export async function mappingTables() {
  await ensure();
  return { byAnilist: byAnilist!, byTvdb: byTvdb!, byMal: byMal!, movieByAnilist: movieByAnilist!, anilistByMovie: anilistByMovie!, imdbByAnilist: imdbByAnilist!, tvdbByAnidb: tvdbByAnidb! };
}
