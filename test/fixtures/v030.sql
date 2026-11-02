-- A database from an install that stopped at schema version 3 (v0.3): no mapping overrides, auto-add or session tables.
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE media (id INTEGER PRIMARY KEY, season TEXT, year INTEGER, data TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE INDEX media_season ON media (season, year);
CREATE TABLE season_fetch (season TEXT NOT NULL, year INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (season, year));
CREATE TABLE feedback (anilist_id INTEGER PRIMARY KEY, verdict TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE dropped (tvdb_id INTEGER PRIMARY KEY, title TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE notified (season TEXT NOT NULL, year INTEGER NOT NULL, PRIMARY KEY (season, year));
CREATE TABLE list_entries (source TEXT NOT NULL, anilist_id INTEGER NOT NULL, status TEXT NOT NULL, score INTEGER, progress INTEGER, PRIMARY KEY (source, anilist_id));
CREATE TABLE jobs (name TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT, started_at INTEGER, finished_at INTEGER);
CREATE TABLE following (anilist_id INTEGER PRIMARY KEY, title TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE aired_notified (anilist_id INTEGER NOT NULL, episode INTEGER NOT NULL, PRIMARY KEY (anilist_id, episode));

INSERT INTO settings VALUES ('settings', '{"sonarr":{"url":"http://sonarr:8989","apiKey":"old-key"}}');
INSERT INTO feedback VALUES (42, 'liked', 'quiz', 1600000000000);
INSERT INTO following VALUES (9, 'Old follow', 1600000000000);
PRAGMA user_version = 3;
