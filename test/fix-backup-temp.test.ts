import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_DIR } from "../server/config.js";
import { clearStaleBackups, snapshotDatabase } from "../server/data/backup.js";
import { db } from "../server/data/db.js";

/**
 * File-safety check L17: database snapshots for the backup download. Two in the same millisecond must not collide (the
 * second's cleanup used to delete the first's file), a failed snapshot removes only the file it created, and copies
 * left by a killed download (every API key in cleartext) are cleared at startup.
 */

const backups = () => fs.readdirSync(CONFIG_DIR).filter((f) => f.startsWith("backup-"));

/** Runs `fn` with Date.now frozen, so both snapshots get the same millisecond. */
function sameMillisecond<T>(fn: () => T): T {
  const real = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("two snapshots in the same millisecond get their own files, and both are complete", () => {
  const [a, b] = sameMillisecond(() => [snapshotDatabase(), snapshotDatabase()]);
  assert.notEqual(a, b);
  for (const f of [a, b]) assert.ok(fs.statSync(f).size > 0, `${f} written`);
  fs.rmSync(a);
  fs.rmSync(b);
});

test("a snapshot that fails removes only the file it created, never another download's", () => {
  const other = sameMillisecond(() => snapshotDatabase());
  const real = db.prepare.bind(db);
  db.prepare = ((sql: string) =>
    sql.startsWith("VACUUM")
      ? {
          run() {
            throw new Error("disk full");
          },
        }
      : real(sql)) as typeof db.prepare;
  try {
    const before = backups();
    assert.throws(() => sameMillisecond(() => snapshotDatabase()), /disk full/);
    assert.deepEqual(backups(), before, "the failed call left nothing behind and removed nothing else");
    assert.ok(fs.existsSync(other), "the other download's snapshot is still there");
  } finally {
    db.prepare = real;
    fs.rmSync(other, { force: true });
  }
});

test("snapshots are readable by the owner only (they hold every API key)", { skip: process.platform === "win32" }, () => {
  const f = snapshotDatabase();
  assert.equal(fs.statSync(f).mode & 0o077, 0);
  fs.rmSync(f);
});

test("copies left behind by a killed download are cleared at startup; nothing else is touched", () => {
  for (const f of ["backup-1700000000000.db", "backup-1700000000001-ab12cd.db", "backup-1700000000002-ef34gh.db-journal"])
    fs.writeFileSync(path.join(CONFIG_DIR, f), "secret api keys");
  fs.writeFileSync(path.join(CONFIG_DIR, "my-backup-notes.db"), "keep");
  const removed = clearStaleBackups();
  assert.equal(removed, 3);
  assert.deepEqual(backups(), []);
  assert.ok(fs.existsSync(path.join(CONFIG_DIR, "tastearr.db")), "the live database stays");
  assert.ok(fs.existsSync(path.join(CONFIG_DIR, "my-backup-notes.db")), "only backup-* snapshot files are removed");
});
