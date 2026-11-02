import { db } from "./db.js";

/** User-confirmed TVDB matches for shows the community mapping doesn't cover yet. */

export function mappingOverrides() {
  return db.prepare("SELECT anilist_id, tvdb_id, season FROM mapping_overrides").all() as {
    anilist_id: number;
    tvdb_id: number;
    season: number | null;
  }[];
}

export function saveMappingOverride(anilistId: number, tvdbId: number, season: number | null) {
  db.prepare(
    "INSERT INTO mapping_overrides (anilist_id, tvdb_id, season, at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET tvdb_id = excluded.tvdb_id, season = excluded.season, at = excluded.at",
  ).run(anilistId, tvdbId, season, Date.now());
}

/** Deletes every override; returns how many there were. */
export function clearMappingOverrides() {
  return Number(db.prepare("DELETE FROM mapping_overrides").run().changes);
}
