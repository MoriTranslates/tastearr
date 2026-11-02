import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect, plantDatabase } from "./data-boot.ts";

/**
 * Failure mode: a migration that breaks halfway must roll back completely (no half-made tables, version not advanced)
 * and the app must refuse to start rather than run on a half-upgraded schema.
 */

test("a failing migration step is rolled back whole and startup fails loudly", async () => {
  // Version 2 database whose later step collides with a pre-existing index of the same name as a table it creates.
  const file = plantDatabase(
    "v030.sql",
    "DROP TABLE following; DROP TABLE aired_notified; CREATE INDEX aired_notified ON jobs (name); PRAGMA user_version = 2;",
  );
  await assert.rejects(import("../server/data/db.js"), /aired_notified/);
  const s = inspect(file);
  assert.equal(s.version, 2, "version not advanced");
  assert.ok(!s.tables.includes("following"), "the step's first statement was rolled back too");
});
