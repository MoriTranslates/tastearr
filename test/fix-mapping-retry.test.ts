import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_DIR } from "../server/config.js";
import { mapAnilist, MAPPING_RETRY } from "../server/services/mapping.js";
import { json, mockFetch, sleep } from "./helpers.ts";
import { quietWarn } from "./world.ts";

/**
 * Review 2026-11-02, item 6: a failed weekly download of the community list wasn't tried again for 7 days. Now it is
 * retried with backoff, and the last good mapping stays in use meanwhile (even when the reload itself fails).
 */

const FILE = path.join(CONFIG_DIR, "anime-list-full.json");
const v1 = [{ anilist_id: 1, tvdb_id: 100, season: { tvdb: 1 } }];
const v2 = [...v1, { anilist_id: 2, tvdb_id: 200, season: { tvdb: 1 } }];
/** A local copy older than the weekly refresh. */
const writeStale = (text: string) => {
  fs.writeFileSync(FILE, text);
  const old = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(FILE, old, old);
};

test("a failed download uses the cached copy and is retried after the backoff, not a week later; the backoff doubles", async () => {
  Object.assign(MAPPING_RETRY, { firstMs: 150, maxMs: 10_000 });
  writeStale(JSON.stringify(v1));
  let ok = false;
  const m = mockFetch((u) => {
    if (u.hostname !== "raw.githubusercontent.com") return undefined;
    return ok ? json(v2) : new Response("", { status: 502 });
  });
  try {
    const first = await quietWarn(() => mapAnilist(1));
    assert.deepEqual(first.value, { tvdbId: 100, season: 1 }, "cached copy in use");
    assert.ok(first.warnings.some((w) => /refresh failed, using the cached copy.*HTTP 502.*trying again/.test(w)));
    assert.equal(m.calls.length, 1);
    await mapAnilist(1);
    assert.equal(m.calls.length, 1, "not hammered: waits for the backoff");

    await sleep(180);
    await quietWarn(() => mapAnilist(1));
    assert.equal(m.calls.length, 2, "retried after firstMs");
    await sleep(180);
    await mapAnilist(1);
    assert.equal(m.calls.length, 2, "second failure: the wait doubled (300 ms)");
    await sleep(180);
    ok = true;
    assert.deepEqual(await mapAnilist(2), { tvdbId: 200, season: 1 }, "the new list is used once downloaded");
    assert.equal(m.calls.length, 3);
    await mapAnilist(2);
    assert.equal(m.calls.length, 3, "after a good refresh: the weekly schedule again");
  } finally {
    m.restore();
  }
});

test("when the reload itself fails (stale, unreadable copy and no download), the tables already loaded keep working", async () => {
  Object.assign(MAPPING_RETRY, { firstMs: 0 });
  // Make the next lookup due for a refresh: the copy is damaged and old, and GitHub is down.
  writeStale("{ not json");
  const m = mockFetch((u) => (u.hostname === "raw.githubusercontent.com" ? new Response("", { status: 503 }) : undefined));
  try {
    const { clearOverrides } = await import("../server/services/mapping.js");
    clearOverrides(); // forces the reload now
    const { value, warnings } = await quietWarn(() => mapAnilist(2));
    assert.deepEqual(value, { tvdbId: 200, season: 1 }, "last good mapping kept");
    assert.ok(warnings.some((w) => /keeping the loaded one/.test(w)));
  } finally {
    m.restore();
  }
});
