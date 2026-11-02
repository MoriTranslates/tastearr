import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { seasonOf } from "../server/core/taste/media.js";
import { seasonAnnounced } from "../server/data/library.js";
import { invalidateContext } from "../server/services/context.js";
import { importAnilist, importMal, listEntries, refreshLists } from "../server/services/lists.js";
import { canNotify, notifySeason, send } from "../server/services/notify.js";
import { patchSettings } from "../server/services/settings.js";
import { installWorld, newWorld, NTFY, quietWarn, resetUserData, seedTaste, writeAnimeList, type World } from "./world.ts";

/** List sync (AniList + MyAnimeList) and the once-a-season announcement. */

let w: World;
let net: ReturnType<typeof installWorld>;
beforeEach(() => {
  resetUserData();
  w = newWorld();
  net = installWorld(w);
  writeAnimeList([
    { anilist_id: 10, mal_id: 1010, tvdb_id: 1 },
    { anilist_id: 20, mal_id: 2020, tvdb_id: 2 },
    { anilist_id: 30, mal_id: 3030 },
  ]);
});
afterEach(() => net.restore());

describe("list sync", () => {
  test("AniList: replaces the previous import, zero scores become null", async () => {
    w.anilistList = [
      { mediaId: 1, status: "COMPLETED", score: 85, progress: 12 },
      { mediaId: 2, status: "DROPPED", score: 0, progress: 3 },
    ];
    assert.deepEqual(await importAnilist("adam"), { source: "anilist", entries: 2 });
    w.anilistList = [{ mediaId: 3, status: "CURRENT", score: 0, progress: 1 }];
    await importAnilist("adam");
    const rows = listEntries().filter((e) => e.source === "anilist");
    assert.deepEqual(
      rows.map((r) => [r.id, r.score]),
      [[3, null]],
    );
  });

  test("AniList failing keeps the old import intact", async () => {
    w.anilistList = [{ mediaId: 1, status: "COMPLETED", score: 85, progress: 12 }];
    await importAnilist("adam");
    w.fail.anilistList = 500;
    await assert.rejects(importAnilist("adam"), /having trouble/);
    assert.equal(listEntries().length, 1);
  });

  test("MAL: ids become AniList ids, statuses are normalised, scores scale to 100, unmapped shows are dropped", async () => {
    w.malList = [
      { id: 1010, status: "completed", score: 9, eps: 12 },
      { id: 2020, status: "plan_to_watch", score: 0, eps: 0 },
      { id: 3030, status: "mystery_new_status", score: 7, eps: 4 },
      { id: 9999, status: "watching", score: 5, eps: 1 },
    ];
    const r = await importMal("adam", "cid");
    assert.deepEqual(r, { source: "mal", entries: 3 });
    const rows = listEntries()
      .filter((e) => e.source === "mal")
      .sort((a, b) => a.id - b.id);
    assert.deepEqual(
      rows.map((x) => [x.id, x.status, x.score, x.progress]),
      [
        [10, "COMPLETED", 90, 12],
        [20, "PLANNING", null, 0],
        [30, "PLANNING", 70, 4],
      ],
    );
  });

  test("MAL without a client id explains what to do; MAL down leaves the old import", async () => {
    await assert.rejects(importMal("adam", ""), /client ID/);
    w.malList = [{ id: 1010, status: "completed", score: 9, eps: 12 }];
    await importMal("adam", "cid");
    w.fail.mal = 429;
    await assert.rejects(importMal("adam", "cid"), /HTTP 429/);
    assert.equal(listEntries().filter((e) => e.source === "mal").length, 1);
  });

  test("refreshLists: runs what is configured; both sources can be set; empty config does nothing", async () => {
    assert.deepEqual(await refreshLists(), []);
    patchSettings((s) => ({ ...s, lists: { anilistUser: "adam", malUser: "adam", malClientId: "cid" } }));
    w.anilistList = [{ mediaId: 1, status: "COMPLETED", score: 80, progress: 1 }];
    w.malList = [{ id: 1010, status: "completed", score: 9, eps: 1 }];
    assert.deepEqual(await refreshLists(), ["1 AniList entries", "1 MAL entries"]);
    patchSettings((s) => ({ ...s, lists: { anilistUser: "", malUser: "adam", malClientId: "" } }));
    assert.deepEqual(await refreshLists(), [], "a MAL user without a client id is skipped");
  });

  test("refreshLists: AniList failing means MAL is not even tried (one source failing skips the other)", async () => {
    patchSettings((s) => ({ ...s, lists: { anilistUser: "adam", malUser: "adam", malClientId: "cid" } }));
    w.malList = [{ id: 1010, status: "completed", score: 9, eps: 1 }];
    w.fail.anilistList = 500;
    await assert.rejects(refreshLists());
    // Documents today's behaviour. The failure-isolation wanted by the brief is the todo below.
    assert.equal(listEntries().filter((e) => e.source === "mal").length, 0);
  });

  test.todo("BUG: refreshLists should still import MAL when AniList fails (it throws on the first failure)");
});

describe("season announcement", () => {
  const cur = seasonOf();
  const setup = (n: number, picks: number) => {
    seedTaste(w, n);
    patchSettings((s) => ({
      ...s,
      training: { ...s.training, seasons: 1 },
      lists: { anilistUser: "adam", malUser: "", malClientId: "" },
      notify: { ...s.notify, ntfyUrl: NTFY, discordWebhook: "", gotifyUrl: "", gotifyToken: "", seasonAlerts: true, picks },
    }));
    invalidateContext();
  };

  test("sends the top picks once, then never again for the same season", async () => {
    setup(6, 5);
    assert.equal(await notifySeason(cur.season, cur.year, true), true);
    assert.equal(w.ntfySent.length, 1);
    assert.match(w.ntfySent[0].message, /^1\. /);
    assert.equal(seasonAnnounced(cur.season, cur.year), true);
    assert.equal(await notifySeason(cur.season, cur.year), false);
    assert.equal(w.ntfySent.length, 1);
  });

  test("a failed send is not recorded as announced, so it is tried again", async () => {
    setup(6, 5);
    w.fail.ntfy = 500;
    await quietWarn(() => assert.rejects(notifySeason(cur.season, cur.year, true)));
    assert.equal(seasonAnnounced(cur.season, cur.year), false);
  });

  test("a half-announced line-up (fewer new shows than wanted) waits", async () => {
    setup(2, 10);
    assert.equal(await notifySeason(cur.season, cur.year, true), false);
    assert.equal(w.ntfySent.length, 0);
  });

  test("send(): no channel does nothing; one channel failing still succeeds; all failing throws", async () => {
    patchSettings((s) => ({ ...s, notify: { ...s.notify, ntfyUrl: "", discordWebhook: "", gotifyUrl: "", gotifyToken: "" } }));
    assert.equal(canNotify(), false);
    assert.deepEqual(await send({ title: "t", body: "b" }), []);
    patchSettings((s) => ({ ...s, notify: { ...s.notify, ntfyUrl: NTFY, discordWebhook: "http://discord.test/hook" } }));
    w.fail.ntfy = 500;
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) =>
      String(u).includes("discord.test") ? Promise.resolve(new Response(null, { status: 204 })) : real(u, i)) as typeof fetch;
    try {
      const { value } = await quietWarn(() => send({ title: "t", body: "b" }));
      assert.deepEqual(value, ["discord"]);
      globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 500 }))) as typeof fetch;
      await quietWarn(() => assert.rejects(send({ title: "t", body: "b" }), /failed/));
    } finally {
      globalThis.fetch = real;
    }
  });
});
