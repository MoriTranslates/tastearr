import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * For migration tests (import after `./env.ts`, before touching `server/data/db.js`): puts a pre-made database file in
 * the private config folder, so the first import of db.js opens and migrates it exactly as a real start would.
 */
export function plantDatabase(fixtureSql: string | null, extraSql = "") {
  const file = path.join(process.env.TASTEARR_CONFIG!, "tastearr.db");
  if (fixtureSql !== null || extraSql) {
    const raw = new DatabaseSync(file);
    if (fixtureSql) raw.exec(fs.readFileSync(path.join(import.meta.dirname, "fixtures", fixtureSql), "utf8"));
    if (extraSql) raw.exec(extraSql);
    raw.close();
  }
  return file;
}

/** Table names and schema version of a database file, opened separately from the app's connection. */
export function inspect(file: string) {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    const version = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    return { tables, version };
  } finally {
    raw.close();
  }
}

export const ALL_TABLES = [
  "aired_notified",
  "auto_added",
  "dropped",
  "feedback",
  "following",
  "jobs",
  "list_entries",
  "mapping_overrides",
  "media",
  "notified",
  "revoked_sessions",
  "season_fetch",
  "settings",
];
