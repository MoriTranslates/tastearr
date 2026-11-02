import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_TABLES, inspect, plantDatabase } from "./data-boot.ts";

/** Upgrading a database a real v0.6.0 install left behind must keep every row and not need any migration. */

test("a v0.6.0 database opens with all data intact and the schema version unchanged by the migration loop", async () => {
  const file = plantDatabase("v060.sql");
  const before = inspect(file);
  assert.equal(before.version, 6);
  const feedback = await import("../server/data/feedback.js");
  const kv = await import("../server/data/kv.js");
  const following = await import("../server/data/following.js");
  const autoadd = await import("../server/data/autoadd.js");
  const lists = await import("../server/data/lists.js");
  const mapping = await import("../server/data/mapping.js");
  const library = await import("../server/data/library.js");
  const media = await import("../server/data/media.js");
  const sessions = await import("../server/data/sessions.js");
  const jobs = await import("../server/data/jobs.js");

  assert.ok(inspect(file).version >= 6);
  for (const t of ALL_TABLES) assert.ok(inspect(file).tables.includes(t));

  assert.match(kv.getValue("settings")!, /fixture-key/);
  assert.deepEqual(
    [...feedback.verdicts()].sort((a, b) => a[0] - b[0]),
    [
      [1, "hidden"],
      [154587, "loved"],
    ],
  );
  assert.deepEqual([...feedback.quizAnswers()], [[154587, "loved"]]);
  assert.deepEqual([...library.droppedSet()], [424536]);
  assert.equal(library.seasonAnnounced("WINTER", 2025), true);
  assert.deepEqual(
    lists.listEntries().map((e) => [e.source, e.id, e.score]),
    [
      ["anilist", 154587, 90],
      ["mal", 52991, null],
    ],
  );
  assert.deepEqual(following.followedIds(), [5]);
  assert.equal(following.announcedChecker()(5, 2), true);
  assert.deepEqual(
    mapping.mappingOverrides().map((o) => ({ ...o })),
    [{ anilist_id: 99, tvdb_id: 123456, season: null }],
  );
  assert.equal((autoadd.autoAddHistory()[0] as { title: string }).title, 'Re:ZERO "S3" & more');
  assert.equal(sessions.isRevoked("abc123"), true);
  assert.equal(jobs.listJobs()[0].detail, "Learned from 120 shows");
  // The cache: a current-schema row with CJK text reads back; an old-schema row is treated as missing, not as an error.
  assert.equal(media.cachedMedia(154587)!.title.native, "葬送のフリーレン");
  assert.equal(media.cachedMedia(8), null);
  assert.deepEqual(
    media
      .cachedSeason("FALL", 2023)
      .map((m) => m?.id ?? null)
      .sort(),
    [154587, null],
  );
});
