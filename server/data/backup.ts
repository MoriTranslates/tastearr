import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";
import { db } from "./db.js";

/** Snapshot files: "backup-<ms>-<random>.db", plus any SQLite side file next to one. */
const SNAPSHOT = /^backup-\d+(-[0-9a-z]+)?\.db(-journal|-wal|-shm)?$/;

/**
 * Writes a consistent copy of the database to a temporary file in the config folder and returns its path. The name is
 * unique (two downloads in the same millisecond don't collide), the file is created exclusively and readable by the
 * owner only (it holds every API key in cleartext), and a failure removes only the file this call created.
 */
export function snapshotDatabase() {
  const tmp = path.join(CONFIG_DIR, `backup-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.db`);
  // "wx" fails if the name exists; VACUUM INTO accepts an existing empty file, so the exclusive create can come first.
  fs.closeSync(fs.openSync(tmp, "wx", 0o600));
  try {
    db.prepare("VACUUM INTO ?").run(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return tmp;
}

/**
 * Removes snapshots a killed process left behind (each a full copy of the database, secrets included). Only called at
 * startup, before any download can be running. Returns how many files were removed.
 */
export function clearStaleBackups() {
  let removed = 0;
  for (const f of fs.readdirSync(CONFIG_DIR)) {
    if (!SNAPSHOT.test(f)) continue;
    fs.rmSync(path.join(CONFIG_DIR, f), { force: true });
    removed++;
  }
  return removed;
}
