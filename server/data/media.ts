import type { Media, Season } from "../core/taste/media.js";
import { db, transaction } from "./db.js";

/** The AniList cache: media rows by id (with the season they were listed in) and when each season was fetched. */

/** Bump when the AniList adapter's fields change so cached rows are refetched. */
export const MEDIA_SCHEMA = 3;

function parse(data: string): Media | null {
  const m = JSON.parse(data) as Media & { _v?: number };
  return m._v === MEDIA_SCHEMA ? m : null;
}

export function storeMedia(list: Media[], season: Season | null, year: number | null) {
  const stmt = db.prepare(
    `INSERT INTO media (id, season, year, data, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at,
       season = COALESCE(excluded.season, media.season), year = COALESCE(excluded.year, media.year)`,
  );
  const now = Date.now();
  transaction(() => {
    for (const m of list) stmt.run(m.id, season, year, JSON.stringify({ ...m, _v: MEDIA_SCHEMA }), now);
  });
}

/** Cached media only, never hits the network. Null when missing or stored by an older schema. */
export function cachedMedia(id: number): Media | null {
  const r = db.prepare("SELECT data FROM media WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
}

/** Cached media for several ids (one prepared statement), by id; missing or outdated rows are left out. */
export function cachedMediaMany(ids: Iterable<number>): Map<number, Media> {
  const have = new Map<number, Media>();
  const get = db.prepare("SELECT data FROM media WHERE id = ?");
  for (const id of ids) {
    const r = get.get(id) as { data: string } | undefined;
    const m = r && parse(r.data);
    if (m) have.set(id, m);
  }
  return have;
}

/** When a season's line-up was last fetched, if ever. */
export function seasonFetchedAt(season: Season, year: number): number | undefined {
  const row = db.prepare("SELECT fetched_at FROM season_fetch WHERE season = ? AND year = ?").get(season, year) as
    { fetched_at: number } | undefined;
  return row?.fetched_at;
}

/** A season's cached line-up; an entry is null when its row needs refetching. */
export function cachedSeason(season: Season, year: number): (Media | null)[] {
  return (db.prepare("SELECT data FROM media WHERE season = ? AND year = ?").all(season, year) as { data: string }[]).map((r) =>
    parse(r.data),
  );
}

/** Stores a freshly fetched season line-up and marks the season fetched. */
export function replaceSeason(list: Media[], season: Season, year: number) {
  transaction(() => {
    storeMedia(list, season, year);
    // Shows AniList moved out of this season (or deleted) must not keep the old tag, or the cache never validates.
    if (list.length)
      db.prepare(
        `UPDATE media SET season = NULL, year = NULL WHERE season = ? AND year = ? AND id NOT IN (${list.map(() => "?").join(",")})`,
      ).run(season, year, ...list.map((m) => m.id));
    db.prepare(
      "INSERT INTO season_fetch (season, year, fetched_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at",
    ).run(season, year, Date.now());
  });
}
