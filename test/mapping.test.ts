import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_DIR } from "../server/db.js";
import { anilistIdsForTvdb, clearOverrides, mapAnilist, mappingFileAge, mappingTables, saveOverride } from "../server/mapping.js";
import { json, mockFetch, sleep } from "./helpers.ts";

const FIXTURE = [
  { anilist_id: 1, tvdb_id: 100, season: { tvdb: 1 }, mal_id: 11, anidb_id: 501 },
  { anilist_id: 2, tvdb_id: 100, season: { tvdb: 2 }, mal_id: 12, anidb_id: 502 },
  { anilist_id: 3, themoviedb_id: { movie: [900] }, imdb_id: ["tt0000001"], mal_id: 13 },
  { anilist_id: 4, themoviedb_id: { movie: 900 } },
  { anilist_id: 5 },
  { tvdb_id: 200, anidb_id: 503 },
  { anilist_id: 6, tvdb_id: 300 },
];

test("requests arriving together share one download of the community list", async () => {
  const m = mockFetch(async (u) => {
    if (u.hostname !== "raw.githubusercontent.com") return undefined;
    await sleep(20);
    return json(FIXTURE);
  });
  try {
    const got = await Promise.all([mapAnilist(1), mapAnilist(2), anilistIdsForTvdb(100), mappingTables(), mapAnilist(5)]);
    assert.equal(m.calls.length, 1);
    assert.deepEqual(got[0], { tvdbId: 100, season: 1 });
    assert.equal(fs.existsSync(path.join(CONFIG_DIR, "anime-list-full.json.tmp")), false);
    assert.ok((mappingFileAge() ?? Infinity) < 60_000);
  } finally {
    m.restore();
  }
});

test("ID resolution: AniList -> TVDB season, TVDB -> AniList, MAL, AniDB, movies", async () => {
  assert.deepEqual(await mapAnilist(2), { tvdbId: 100, season: 2 });
  assert.deepEqual(await mapAnilist(6), { tvdbId: 300, season: null });
  assert.equal(await mapAnilist(5), null, "no TVDB id");
  assert.equal(await mapAnilist(999), null);
  assert.deepEqual(await anilistIdsForTvdb(100), [1, 2]);
  assert.deepEqual(await anilistIdsForTvdb(12345), []);
  const t = await mappingTables();
  assert.equal(t.byMal.get(11), 1);
  assert.equal(t.byMal.get(13), 3);
  assert.equal(t.tvdbByAnidb.get(501), 100);
  assert.equal(t.tvdbByAnidb.get(503), 200);
  assert.equal(t.movieByAnilist.get(3), 900);
  assert.equal(t.movieByAnilist.get(4), 900);
  assert.deepEqual(t.anilistByMovie.get(900), [3, 4]);
  assert.equal(t.imdbByAnilist.get(3), "tt0000001");
});

test("a hand-picked match wins and moves the show between series; reset restores the list", async () => {
  await saveOverride(2, 300, 1);
  assert.deepEqual(await mapAnilist(2), { tvdbId: 300, season: 1 });
  assert.deepEqual(await anilistIdsForTvdb(100), [1]);
  assert.deepEqual([...(await anilistIdsForTvdb(300))].sort(), [2, 6]);
  assert.equal(clearOverrides(), 1);
  assert.deepEqual(await mapAnilist(2), { tvdbId: 100, season: 2 });
  assert.deepEqual(await anilistIdsForTvdb(100), [1, 2]);
});

test("a failed refresh keeps using the cached copy", async () => {
  const file = path.join(CONFIG_DIR, "anime-list-full.json");
  const old = new Date(Date.now() - 30 * 86_400_000);
  fs.utimesSync(file, old, old);
  clearOverrides(); // forces a reload
  const m = mockFetch((u) => (u.hostname === "raw.githubusercontent.com" ? new Response("down", { status: 503 }) : undefined));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    assert.deepEqual(await mapAnilist(1), { tvdbId: 100, season: 1 });
    assert.equal(m.calls.length, 1);
  } finally {
    console.warn = warn;
    m.restore();
  }
});
