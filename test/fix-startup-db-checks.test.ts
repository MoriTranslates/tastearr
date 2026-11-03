import "./env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

/**
 * File-safety check, startup: a damaged database stops startup with a clear message (and is left alone), and an
 * existing database gets a copy before migrations run; if that copy can't be made, nothing is migrated. These checks
 * exit the process, so they run in a child process.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(import.meta.dirname, "fixtures");

function boot(configDir: string) {
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "--input-type=module", "-e", "await import('./server/data/db.ts'); console.log('started');"],
    { cwd: ROOT, env: { ...process.env, TASTEARR_CONFIG: configDir }, encoding: "utf8", timeout: 60_000 },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "startup-db-"));
/** A v0.6.0 database (schema version 6, with data), as an older Tastearr left it. */
function plantV060(dir: string) {
  const file = path.join(dir, "tastearr.db");
  const raw = new DatabaseSync(file);
  raw.exec(fs.readFileSync(path.join(FIXTURES, "v060.sql"), "utf8"));
  raw.close();
  return file;
}
const versionOf = (file: string) => {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    raw.close();
  }
};

test("a file that isn't a database stops startup with a clear message and is left alone", () => {
  const dir = freshDir();
  const file = path.join(dir, "tastearr.db");
  fs.writeFileSync(file, Buffer.alloc(8192, 0x41));
  const before = fs.readFileSync(file);
  const r = boot(dir);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /started/);
  assert.match(r.err, /tastearr\.db is damaged or isn't a Tastearr database/);
  assert.match(r.err, /restore a backup/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("a database with damaged pages fails the quick check and stops startup", () => {
  const dir = freshDir();
  const file = plantV060(dir);
  // Overwrite a stretch of pages after the header with garbage: the header still reads, the b-trees don't.
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, Buffer.alloc(4096 * 3, 0xff), 0, 4096 * 3, 4096);
  fs.closeSync(fd);
  const r = boot(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /tastearr\.db is damaged/);
});

test("before migrating an existing database, a copy of it is kept; the copy is the old version, the live one is migrated", () => {
  const dir = freshDir();
  const file = plantV060(dir);
  const r = boot(dir);
  assert.equal(r.code, 0, r.err);
  const copy = path.join(dir, "tastearr-before-v6.db");
  assert.ok(fs.existsSync(copy), fs.readdirSync(dir).join(", "));
  assert.equal(versionOf(copy), 6);
  assert.equal(versionOf(file), 8);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "no temporary file left");
});

test("if the copy can't be made, nothing is migrated and startup stops", () => {
  const dir = freshDir();
  const file = plantV060(dir);
  // Something unremovable where the copy's temporary file goes (a folder with a file in it).
  fs.mkdirSync(path.join(dir, "tastearr-before-v6.db.tmp", "x"), { recursive: true });
  const r = boot(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /Couldn't make a safety copy of tastearr\.db before upgrading it/);
  assert.equal(versionOf(file), 6, "not migrated");
});

test("a fresh install needs no copy", () => {
  const dir = freshDir();
  const r = boot(dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith("tastearr-before")),
    [],
  );
});
