import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const CONFIG_DIR = process.env.TASTEARR_CONFIG ?? "/config";
fs.mkdirSync(CONFIG_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(CONFIG_DIR, "tastearr.db"));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- AniList media, keyed by AniList id. season/year are null for items fetched outside a season list (quiz, feedback).
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, season TEXT, year INTEGER, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS media_season ON media (season, year);
CREATE TABLE IF NOT EXISTS season_fetch (season TEXT NOT NULL, year INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (season, year));
-- verdict: loved | liked | meh | disliked | hidden | added ; source: quiz | picks
CREATE TABLE IF NOT EXISTS feedback (anilist_id INTEGER PRIMARY KEY, verdict TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL);
-- Series the user is "not into anymore", keyed by TVDB id.
CREATE TABLE IF NOT EXISTS dropped (tvdb_id INTEGER PRIMARY KEY, title TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notified (season TEXT NOT NULL, year INTEGER NOT NULL, PRIMARY KEY (season, year));
`);

export function droppedSet(): Set<number> {
  return new Set((db.prepare("SELECT tvdb_id FROM dropped").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
}
