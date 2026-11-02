import type { Season } from "../../shared/api.js";
import { db } from "./db.js";

/** Shows auto-add sent to Sonarr/Radarr (each at most once, so a removed show never comes back). */

export function autoAddedIds() {
  return new Set((db.prepare("SELECT anilist_id FROM auto_added").all() as { anilist_id: number }[]).map((r) => r.anilist_id));
}

export function autoAddedInSeason(season: Season, year: number) {
  return (db.prepare("SELECT COUNT(*) AS n FROM auto_added WHERE season = ? AND year = ?").get(season, year) as { n: number }).n;
}

export function recordAutoAdd(r: { id: number; title: string; season: Season; year: number; match: number; detail: string }) {
  db.prepare("INSERT OR IGNORE INTO auto_added (anilist_id, title, season, year, match, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    r.id,
    r.title,
    r.season,
    r.year,
    r.match,
    r.detail,
    Date.now(),
  );
}

export function autoAddHistory() {
  return db.prepare("SELECT anilist_id AS id, title, season, year, match, detail, at FROM auto_added ORDER BY at DESC LIMIT 50").all();
}
