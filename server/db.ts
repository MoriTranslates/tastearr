import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const CONFIG_DIR = process.env.TASTEARR_CONFIG ?? "/config";
fs.mkdirSync(CONFIG_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(CONFIG_DIR, "tastearr.db"));
db.exec("PRAGMA journal_mode = WAL;");

/**
 * Schema migrations, applied in order; PRAGMA user_version records how many have run.
 * Never edit a released step, append a new one.
 */
const MIGRATIONS: string[] = [
  // 1: v0.1 schema
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- AniList media by id. season/year are null for items fetched outside a season list (quiz, feedback).
   CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, season TEXT, year INTEGER, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS media_season ON media (season, year);
   CREATE TABLE IF NOT EXISTS season_fetch (season TEXT NOT NULL, year INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (season, year));
   -- verdict: loved | liked | meh | disliked | hidden | added ; source: quiz | picks
   CREATE TABLE IF NOT EXISTS feedback (anilist_id INTEGER PRIMARY KEY, verdict TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL);
   -- Series the user is "not into anymore", keyed by TVDB id.
   CREATE TABLE IF NOT EXISTS dropped (tvdb_id INTEGER PRIMARY KEY, title TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notified (season TEXT NOT NULL, year INTEGER NOT NULL, PRIMARY KEY (season, year));`,
  // 2: imported AniList/MAL list entries (keyed by AniList id), background job status
  `CREATE TABLE IF NOT EXISTS list_entries (source TEXT NOT NULL, anilist_id INTEGER NOT NULL, status TEXT NOT NULL, score INTEGER, progress INTEGER, PRIMARY KEY (source, anilist_id));
   CREATE TABLE IF NOT EXISTS jobs (name TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT, started_at INTEGER, finished_at INTEGER);`,
  // 3: follow list for people without Sonarr, and which aired episodes were already announced
  `CREATE TABLE IF NOT EXISTS following (anilist_id INTEGER PRIMARY KEY, title TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS aired_notified (anilist_id INTEGER NOT NULL, episode INTEGER NOT NULL, PRIMARY KEY (anilist_id, episode));`,
  // 4: user-confirmed TVDB matches for shows the community mapping doesn't cover yet
  `CREATE TABLE IF NOT EXISTS mapping_overrides (anilist_id INTEGER PRIMARY KEY, tvdb_id INTEGER NOT NULL, season INTEGER, at INTEGER NOT NULL);`,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let v = current; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function droppedSet(): Set<number> {
  return new Set((db.prepare("SELECT tvdb_id FROM dropped").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
}

export function setJob(name: string, state: "running" | "done" | "error", detail = "") {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (name, state, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET state = excluded.state, detail = excluded.detail,
       started_at = CASE WHEN excluded.state = 'running' AND jobs.state != 'running' THEN excluded.started_at ELSE jobs.started_at END,
       finished_at = excluded.finished_at`,
  ).run(name, state, detail, now, state === "running" ? null : now);
}

export function listJobs() {
  return db.prepare("SELECT name, state, detail, started_at AS startedAt, finished_at AS finishedAt FROM jobs ORDER BY name").all();
}
