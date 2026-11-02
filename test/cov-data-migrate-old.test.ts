import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TABLES, inspect, plantDatabase } from "./data-boot.ts";

/** An older database is upgraded step by step with its data kept. */

test("a version-3 database gains the newer tables and keeps its rows", async () => {
  const file = plantDatabase("v030.sql");
  assert.equal(inspect(file).version, 3);
  assert.ok(!inspect(file).tables.includes("auto_added"));
  const { db } = await import("../server/data/db.js");
  const after = inspect(file);
  assert.ok(after.version >= 6);
  for (const t of ALL_TABLES) assert.ok(after.tables.includes(t), `missing ${t}`);
  assert.equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string }).value,
    '{"sonarr":{"url":"http://sonarr:8989","apiKey":"old-key"}}',
  );
  assert.equal((db.prepare("SELECT verdict FROM feedback WHERE anilist_id = 42").get() as { verdict: string }).verdict, "liked");
  assert.equal((db.prepare("SELECT title FROM following WHERE anilist_id = 9").get() as { title: string }).title, "Old follow");
});
