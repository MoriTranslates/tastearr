import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { autoAddedIds, autoAddedInSeason, autoAddHistory, recordAutoAdd } from "../server/data/autoadd.js";
import { snapshotDatabase } from "../server/data/backup.js";
import { db, transaction } from "../server/data/db.js";
import { allFeedback, likedSince, quizAnswers, setVerdict, verdicts } from "../server/data/feedback.js";
import { addFollow, announcedChecker, followedIds, markAnnounced, removeFollow } from "../server/data/following.js";
import { listJobs, setJob } from "../server/data/jobs.js";
import { getValue, setValue } from "../server/data/kv.js";
import { addDropped, droppedSet, markSeasonAnnounced, removeDropped, seasonAnnounced } from "../server/data/library.js";
import { listEntries, replaceListEntries } from "../server/data/lists.js";
import { clearMappingOverrides, mappingOverrides, saveMappingOverride } from "../server/data/mapping.js";
import {
  cachedMedia,
  cachedMediaMany,
  cachedSeason,
  replaceSeason,
  seasonFetchedAt,
  storeMedia,
  MEDIA_SCHEMA,
} from "../server/data/media.js";
import { isRevoked, revoke } from "../server/data/sessions.js";
import { media } from "./helpers.ts";

describe("key-value", () => {
  test("round-trips text with CJK, quotes, newlines and a NUL-free large document; overwrite replaces", () => {
    const doc = JSON.stringify({ t: '葬送のフリーレン "quoted" \n line', big: "x".repeat(500_000) });
    setValue("doc", doc);
    assert.equal(getValue("doc"), doc);
    setValue("doc", "{}");
    assert.equal(getValue("doc"), "{}");
    assert.equal(getValue("never-set"), undefined);
  });
});

describe("feedback", () => {
  test("upsert, clear with null, quiz vs picks, likedSince only counts picks thumbs-up/hearts after the cut-off", () => {
    setVerdict(1, "loved", "quiz");
    setVerdict(2, "liked", "picks");
    setVerdict(3, "disliked", "picks");
    setVerdict(4, "loved", "picks");
    setVerdict(5, "liked", "picks");
    setVerdict(2, "meh", "picks"); // changed its mind
    db.prepare("UPDATE feedback SET at = 1000 WHERE anilist_id IN (1, 2, 3, 4)").run();
    db.prepare("UPDATE feedback SET at = 5000 WHERE anilist_id = 5").run();
    assert.deepEqual([...quizAnswers()], [[1, "loved"]]);
    assert.equal(verdicts().get(2), "meh");
    assert.deepEqual(likedSince(2000).sort(), [5]);
    assert.deepEqual(likedSince(0).sort(), [4, 5]);
    setVerdict(4, null, "picks");
    assert.equal(verdicts().has(4), false);
    assert.equal(allFeedback().length, 4);
    setVerdict(999, null, "picks"); // clearing something that was never set is harmless
  });
});

describe("media cache", () => {
  test("stores and reads CJK titles; outdated schema rows read as missing", () => {
    const m = media(10, { title: { romaji: "Oshi no Ko", english: null, native: "【推しの子】" }, description: "line1\nline2 \u{1F600}" });
    storeMedia([m], "SPRING", 2023);
    assert.deepEqual(cachedMedia(10)!.title, m.title);
    assert.equal(cachedMedia(10)!.description, m.description);
    db.prepare("UPDATE media SET data = ? WHERE id = 10").run(JSON.stringify({ ...m, _v: MEDIA_SCHEMA - 1 }));
    assert.equal(cachedMedia(10), null);
    assert.equal(cachedMedia(424242), null);
    assert.equal(cachedMediaMany([10, 424242]).size, 0);
  });

  test("storing without a season keeps the season it already had", () => {
    storeMedia([media(20)], "WINTER", 2024);
    storeMedia([media(20)], null, null);
    assert.deepEqual(
      cachedSeason("WINTER", 2024).map((x) => x?.id),
      [20],
    );
  });

  test("replaceSeason: shows moved out of the season lose its tag; the season is marked fetched; an empty list keeps old rows", () => {
    replaceSeason([media(31), media(32)], "FALL", 2024);
    assert.ok(seasonFetchedAt("FALL", 2024)! > 0);
    replaceSeason([media(32), media(33)], "FALL", 2024);
    assert.deepEqual(
      cachedSeason("FALL", 2024)
        .map((x) => x!.id)
        .sort(),
      [32, 33],
    );
    assert.ok(cachedMedia(31), "the row itself is still cached for lookups by id");
    replaceSeason([], "FALL", 2024);
    assert.equal(cachedSeason("FALL", 2024).length, 2, "an empty reply from AniList must not wipe the cached season");
    assert.equal(seasonFetchedAt("SUMMER", 1999), undefined);
  });

  test("a big season (hundreds of rows) stores in one transaction", () => {
    const big = Array.from({ length: 600 }, (_, i) => media(10_000 + i));
    const t0 = Date.now();
    replaceSeason(big, "SUMMER", 2025);
    assert.equal(cachedSeason("SUMMER", 2025).length, 600);
    assert.ok(Date.now() - t0 < 3000);
  });
});

describe("transactions", () => {
  test("a throw rolls everything back and the connection stays usable", () => {
    assert.throws(
      () =>
        transaction(() => {
          setValue("tx", "1");
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(getValue("tx"), undefined);
    setValue("tx", "2");
    assert.equal(getValue("tx"), "2");
  });

  test("nested transactions join the outer one: an inner failure caught outside still rolls the outer back when it rethrows", () => {
    assert.throws(() =>
      transaction(() => {
        setValue("outer", "1");
        transaction(() => setValue("inner", "1"));
        throw new Error("late failure");
      }),
    );
    assert.equal(getValue("outer"), undefined);
    assert.equal(getValue("inner"), undefined);
  });

  test("replaceListEntries is all-or-nothing: a bad row leaves the old list in place", () => {
    replaceListEntries("anilist", [{ id: 1, status: "COMPLETED", score: 90, progress: 1 }]);
    assert.throws(() =>
      replaceListEntries("anilist", [
        { id: 2, status: "CURRENT", score: null, progress: null },
        { id: 3, status: null as unknown as string, score: null, progress: null }, // NOT NULL violation
      ]),
    );
    assert.deepEqual(
      listEntries()
        .filter((e) => e.source === "anilist")
        .map((e) => e.id),
      [1],
    );
  });
});

describe("other repositories", () => {
  test("lists: sources are independent; a duplicate id in one import keeps the last", () => {
    replaceListEntries("mal", [
      { id: 7, status: "DROPPED", score: null, progress: 1 },
      { id: 7, status: "COMPLETED", score: 80, progress: 12 },
    ]);
    replaceListEntries("anilist", []);
    const mal = listEntries().filter((e) => e.source === "mal");
    assert.deepEqual(
      mal.map((e) => [e.id, e.status]),
      [[7, "COMPLETED"]],
    );
  });

  test("following: following twice is fine; episodes before the next one are pre-announced; unfollow keeps announced marks", () => {
    addFollow(50, "【推しの子】", 4);
    addFollow(50, "【推しの子】", 4);
    assert.deepEqual(
      followedIds().filter((i) => i === 50),
      [50],
    );
    const seen = announcedChecker();
    assert.deepEqual(
      [1, 2, 3, 4].map((e) => seen(50, e)),
      [true, true, true, false],
    );
    markAnnounced(50, 4);
    markAnnounced(50, 4);
    removeFollow(50);
    assert.equal(followedIds().includes(50), false);
    assert.equal(announcedChecker()(50, 4), true);
  });

  test("auto-add record: stored once per show, counted by season, quotes and CJK survive", () => {
    recordAutoAdd({ id: 60, title: 'Re:ZERO "S3" 葬送', season: "FALL", year: 2030, match: 90, detail: "Sonarr" });
    recordAutoAdd({ id: 60, title: "different", season: "FALL", year: 2030, match: 10, detail: "again" });
    assert.equal(autoAddedInSeason("FALL", 2030), 1);
    assert.ok(autoAddedIds().has(60));
    const h = autoAddHistory() as { id: number; title: string; match: number }[];
    assert.deepEqual(
      h.filter((x) => x.id === 60).map((x) => [x.title, x.match]),
      [['Re:ZERO "S3" 葬送', 90]],
    );
    assert.equal(autoAddedInSeason("WINTER", 2030), 0);
  });

  test("dropped, announced seasons, mapping overrides and revoked sessions", () => {
    addDropped(77, "A");
    addDropped(77, "A again");
    assert.ok(droppedSet().has(77));
    removeDropped(77);
    removeDropped(77);
    assert.ok(!droppedSet().has(77));
    markSeasonAnnounced("SPRING", 2031);
    markSeasonAnnounced("SPRING", 2031);
    assert.equal(seasonAnnounced("SPRING", 2031), true);
    assert.equal(seasonAnnounced("SPRING", 2032), false);
    saveMappingOverride(5, 100, null);
    saveMappingOverride(5, 200, 2);
    assert.deepEqual(
      mappingOverrides().map((o) => ({ ...o })),
      [{ anilist_id: 5, tvdb_id: 200, season: 2 }],
    );
    assert.equal(clearMappingOverrides(), 1);
    assert.equal(clearMappingOverrides(), 0);
    revoke("old", Date.now() - 1000);
    revoke("new", Date.now() + 60_000);
    assert.equal(isRevoked("old"), false, "expired revocations are purged on the next revoke");
    assert.equal(isRevoked("new"), true);
  });

  test("jobs: started_at survives running -> done; a new run resets it", () => {
    setJob("j", "running", "a");
    const first = listJobs().find((j) => j.name === "j")!;
    setJob("j", "running", "b");
    assert.equal(listJobs().find((j) => j.name === "j")!.startedAt, first.startedAt);
    setJob("j", "done", "ok");
    const done = listJobs().find((j) => j.name === "j")!;
    assert.equal(done.state, "done");
    assert.ok(done.finishedAt);
    setJob("j", "running", "again");
    assert.equal(listJobs().find((j) => j.name === "j")!.finishedAt, null);
  });
});

describe("backup", () => {
  test("snapshotDatabase writes a readable copy with the data in it", async () => {
    setValue("snap", "葬送");
    const file = snapshotDatabase();
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const copy = new DatabaseSync(file, { readOnly: true });
      assert.equal((copy.prepare("SELECT value FROM settings WHERE key = 'snap'").get() as { value: string }).value, "葬送");
      copy.close();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
