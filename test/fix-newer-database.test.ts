import "./env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

/**
 * File-safety check L16: a database last used by a newer Tastearr (user_version above the migrations this build has)
 * must stop startup with a clear message and leave the file untouched, not run against a schema it doesn't know.
 * The check exits the process, so it runs in a child process.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

/** Starts the data layer in a child process with its own config folder; returns its exit code and stderr. */
function boot(configDir: string) {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "--input-type=module", "-e", "await import('./server/data/db.ts'); console.log('started');"],
    { cwd: ROOT, env: { ...process.env, TASTEARR_CONFIG: configDir }, encoding: "utf8", timeout: 60_000 },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function plant(version: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newer-db-"));
  const file = path.join(dir, "tastearr.db");
  const raw = new DatabaseSync(file);
  raw.exec(
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE from_the_future (x INTEGER); PRAGMA user_version = ${version};`,
  );
  raw.close();
  return { dir, file };
}

const inspect = (file: string) => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const version = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const mode = (raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    return { version, mode };
  } finally {
    raw.close();
  }
};

test("a database from a newer Tastearr refuses to start, says why, and is left untouched", () => {
  const { dir, file } = plant(99);
  const before = fs.readFileSync(file);
  const r = boot(dir);
  assert.equal(r.code, 1, `exit code (stdout: ${r.out})`);
  assert.doesNotMatch(r.out, /started/);
  assert.match(r.err, /newer version of Tastearr/);
  assert.match(r.err, /database version 99/);
  assert.match(r.err, /this version knows up to 8/);
  assert.equal(inspect(file).version, 99);
  assert.deepEqual(fs.readFileSync(file), before, "not a byte changed (not even the journal mode)");
});

test("a database at this build's own version starts normally", () => {
  const { dir } = plant(8);
  const r = boot(dir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /started/);
});
