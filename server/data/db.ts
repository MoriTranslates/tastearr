import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";

/** The SQLite connection, its schema migrations and transactions. The rest of data/ holds the queries. */

try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.accessSync(CONFIG_DIR, fs.constants.W_OK);
  // Files left by an older version that ran as root.
  for (const f of ["tastearr.db", "tastearr.db-wal", "tastearr.db-shm", "anime-list-full.json"])
    if (fs.existsSync(path.join(CONFIG_DIR, f))) fs.accessSync(path.join(CONFIG_DIR, f), fs.constants.W_OK);
} catch {
  // The usual first-run problem: Docker created the folder as root, and Tastearr runs as a normal user.
  const who = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.()}` : "the container user";
  console.error(
    `Tastearr can't write to ${CONFIG_DIR}. Give it to the user the container runs as (${who}), e.g. on Unraid: chown -R 99:100 /mnt/user/appdata/tastearr`,
  );
  process.exit(1);
}

export const db = new DatabaseSync(path.join(CONFIG_DIR, "tastearr.db"));

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
  // 5: shows auto-add sent to Sonarr/Radarr (each at most once, so a removed show never comes back)
  `CREATE TABLE IF NOT EXISTS auto_added (anilist_id INTEGER PRIMARY KEY, title TEXT NOT NULL, season TEXT NOT NULL, year INTEGER NOT NULL, match INTEGER NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);`,
  // 6: logged-out session cookies (SHA-256 of the cookie), kept until they would have expired anyway
  `CREATE TABLE IF NOT EXISTS revoked_sessions (hash TEXT PRIMARY KEY, exp INTEGER NOT NULL);`,
  // 7: "new episode" alerts still being batched, so a crash or kill doesn't lose them. `rev` changes on every merge, so
  // a flush only deletes the batch it actually sent.
  `CREATE TABLE IF NOT EXISTS pending_alerts (tvdb_id INTEGER PRIMARY KEY, series TEXT NOT NULL, episodes TEXT NOT NULL,
     first_at INTEGER NOT NULL, due_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);`,
  // 8: job history kept apart from the latest state, so a later success doesn't erase the last failure
  `ALTER TABLE jobs ADD COLUMN last_error TEXT;
   ALTER TABLE jobs ADD COLUMN last_error_at INTEGER;
   ALTER TABLE jobs ADD COLUMN last_success_at INTEGER;
   UPDATE jobs SET last_error = detail, last_error_at = finished_at WHERE state = 'error';
   UPDATE jobs SET last_success_at = finished_at WHERE state = 'done';`,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
// A database last used by a newer Tastearr (downgraded image, a backup from a newer version): its schema has steps
// this build doesn't know, so running against it could misread or damage it. Stop before writing anything.
if (current > MIGRATIONS.length) {
  console.error(
    `This tastearr.db was last used by a newer version of Tastearr (database version ${current}; this version knows up to ${MIGRATIONS.length}). Update Tastearr to the newer version again, or restore a backup made with this version. Nothing was changed.`,
  );
  db.close();
  process.exit(1);
}
db.exec("PRAGMA journal_mode = WAL;");
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

/**
 * Runs `fn` in one transaction. Many single-row writes otherwise each commit (and sync to disk) on their own, which
 * blocks the server for seconds on a slow appdata disk when a season of several hundred shows is stored.
 */
let txDepth = 0;
export function transaction<T>(fn: () => T): T {
  if (txDepth) return fn(); // already inside one: the outer transaction commits
  db.exec("BEGIN");
  txDepth++;
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    txDepth--;
  }
}

/** Closes the database on shutdown. */
export function closeDb() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
