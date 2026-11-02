import { db } from "./db.js";

/** Series the user is "not into anymore", keyed by TVDB id; and the seasons whose picks were already announced. */

export function droppedSet(): Set<number> {
  return new Set((db.prepare("SELECT tvdb_id FROM dropped").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
}

export function addDropped(tvdbId: number, title: string) {
  db.prepare("INSERT INTO dropped (tvdb_id, title, at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at").run(
    tvdbId,
    title,
    Date.now(),
  );
}

export function removeDropped(tvdbId: number) {
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
}

export function seasonAnnounced(season: string, year: number) {
  return !!db.prepare("SELECT 1 FROM notified WHERE season = ? AND year = ?").get(season, year);
}

export function markSeasonAnnounced(season: string, year: number) {
  db.prepare("INSERT OR IGNORE INTO notified (season, year) VALUES (?, ?)").run(season, year);
}
