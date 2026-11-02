import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config.js";
import { db } from "./db.js";

/** Writes a consistent copy of the database to a temporary file in the config folder and returns its path. */
export function snapshotDatabase() {
  const tmp = path.join(CONFIG_DIR, `backup-${Date.now()}.db`);
  try {
    db.prepare("VACUUM INTO ?").run(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return tmp;
}
