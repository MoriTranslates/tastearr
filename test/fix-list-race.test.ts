import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { listEntries } from "../server/data/lists.js";
import { forgetUnconfiguredLists, importAnilist, importMal, refreshListsDetailed } from "../server/services/lists.js";
import { patchSettings } from "../server/services/settings.js";
import { json, mockFetch } from "./helpers.ts";
import { resetUserData, writeAnimeList } from "./world.ts";

/**
 * Fix-branch review #8: the user clears a list's username (and saves) while that list is downloading. The import that
 * was already running must not write the disconnected list back.
 */

let m: ReturnType<typeof mockFetch> | null = null;
afterEach(() => m?.restore());
beforeEach(() => {
  resetUserData();
  writeAnimeList([{ anilist_id: 10, mal_id: 1010, tvdb_id: 1 }]);
  patchSettings((s) => ({ ...s, lists: { anilistUser: "adam", malUser: "adam", malClientId: "cid" } }));
});

/** The settings save that happens while the download is in flight: username cleared, its entries forgotten. */
const clearWhileDownloading = (which: "anilistUser" | "malUser") => {
  patchSettings((s) => ({ ...s, lists: { ...s.lists, [which]: "" } }));
  forgetUnconfiguredLists();
};

test("AniList: a username cleared while its list downloads is not written back", async () => {
  m = mockFetch((u) => {
    if (u.hostname !== "graphql.anilist.co") return undefined;
    clearWhileDownloading("anilistUser");
    return json({
      data: { MediaListCollection: { lists: [{ entries: [{ mediaId: 10, status: "COMPLETED", score: 90, progress: 12 }] }] } },
    });
  });
  await assert.rejects(importAnilist("adam"), /changed while its list was downloading/);
  assert.equal(listEntries().filter((e) => e.source === "anilist").length, 0);
});

test("MAL: the same, and refreshListsDetailed reports it as a list error", async () => {
  m = mockFetch((u) => {
    if (u.hostname === "graphql.anilist.co") return json({ data: { MediaListCollection: { lists: [{ entries: [] }] } } });
    if (u.hostname !== "api.myanimelist.net") return undefined;
    clearWhileDownloading("malUser");
    return json({ data: [{ node: { id: 1010 }, list_status: { status: "completed", score: 9, num_episodes_watched: 12 } }], paging: {} });
  });
  const r = await refreshListsDetailed();
  assert.match(r.errors.join(" "), /MAL: .*changed while its list was downloading/);
  assert.equal(listEntries().filter((e) => e.source === "mal").length, 0);
});

test("an unchanged username still imports as before", async () => {
  m = mockFetch((u) =>
    u.hostname === "api.myanimelist.net"
      ? json({ data: [{ node: { id: 1010 }, list_status: { status: "completed", score: 9, num_episodes_watched: 12 } }], paging: {} })
      : undefined,
  );
  assert.deepEqual(await importMal("adam", "cid"), { source: "mal", entries: 1 });
});
