import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TABLES, inspect, plantDatabase } from "./data-boot.ts";

test("a first start creates every table and records the schema version", async () => {
  const file = plantDatabase(null);
  const { db, transaction } = await import("../server/data/db.js");
  const s = inspect(file);
  for (const t of ALL_TABLES) assert.ok(s.tables.includes(t), `missing table ${t}`);
  assert.ok(s.version >= 6, `schema version ${s.version}`);
  // The schema must be usable, not just present.
  transaction(() => db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run());
  assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'k'").get() as { value: string }).value, "v");
});
