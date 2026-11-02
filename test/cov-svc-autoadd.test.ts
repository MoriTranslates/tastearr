import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { seasonOf } from "../server/core/taste/media.js";
import { autoAddedIds, autoAddHistory } from "../server/data/autoadd.js";
import { feedbackFor } from "./cov-feedback.ts";
import { autoAddCandidates, runAutoAdd } from "../server/services/autoadd.js";
import { invalidateContext } from "../server/services/context.js";
import { forgetSeries } from "../server/services/sonarr.js";
import { patchSettings } from "../server/services/settings.js";
import { installWorld, newWorld, NTFY, quietWarn, resetUserData, seedTaste, writeAnimeList, SONARR, type World } from "./world.ts";

/** Auto-add end to end: picks above the bar go to Sonarr, each at most once, and one failure never blocks the rest. */

let w: World;
let net: ReturnType<typeof installWorld>;
const cur = seasonOf();
const configure = (over: Record<string, unknown> = {}) =>
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: SONARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/tv" },
    lists: { anilistUser: "adam", malUser: "", malClientId: "" },
    training: { ...s.training, seasons: 1 },
    notify: { ...s.notify, ntfyUrl: NTFY },
    autoAdd: {
      ...s.autoAdd,
      enabled: true,
      minMatch: 1,
      newShows: true,
      sequels: true,
      movies: false,
      maxPerSeason: 10,
      search: false,
      ...over,
    },
  }));

beforeEach(() => {
  resetUserData();
  w = newWorld();
  net = installWorld(w);
  const fresh = seedTaste(w, 3);
  writeAnimeList(fresh.map((m, i) => ({ anilist_id: m.id, tvdb_id: 5000 + i, season: { tvdb: 1 } })));
  for (const m of fresh)
    w.sonarrLookup.set(5000 + (m.id - 300), {
      title: `Show ${m.id}`,
      tvdbId: 5000 + (m.id - 300),
      year: 2026,
      seasons: [{ seasonNumber: 1, monitored: false }],
    });
  configure();
  invalidateContext();
  forgetSeries();
});
afterEach(() => net.restore());

describe("auto-add", () => {
  test("adds confident picks to Sonarr as anime, records them, rates them 'added' and sends a summary", async () => {
    const added = await runAutoAdd();
    assert.equal(added.length, 3);
    assert.equal(w.sonarrAdded.length, 3);
    assert.ok(w.sonarrAdded.every((s) => s.seriesType === "anime" && s.qualityProfileId === 4 && s.rootFolderPath === "/tv"));
    assert.deepEqual([...autoAddedIds()].sort(), [300, 301, 302]);
    assert.equal(autoAddHistory().length, 3);
    assert.equal(feedbackFor(300), "added");
    assert.match(w.ntfySent.at(-1)!.title, /added 3 shows/);
  });

  test("a second run adds nothing: each show at most once, even if removed from Sonarr", async () => {
    await runAutoAdd();
    w.sonarrAdded.length = 0;
    forgetSeries();
    invalidateContext();
    assert.deepEqual(await runAutoAdd(), []);
    assert.equal(w.sonarrAdded.length, 0);
  });

  test("one add failing (Sonarr 500 for that show) does not stop the others and is retried next run", async () => {
    w.failAddFor.add(5001);
    const { value: added, warnings } = await quietWarn(() => runAutoAdd());
    assert.deepEqual(added.map((a) => a.title.replace(/ \(.*/, "")).sort(), ["Journey 0", "Journey 2"]);
    assert.ok(warnings.some((x) => /will retry/.test(x)));
    assert.deepEqual([...autoAddedIds()].sort(), [300, 302], "the failed one is not recorded");
    w.failAddFor.clear();
    invalidateContext();
    forgetSeries();
    const second = await runAutoAdd();
    assert.equal(second.length, 1);
    assert.deepEqual([...autoAddedIds()].sort(), [300, 301, 302]);
  });

  test("the per-season cap is respected", async () => {
    configure({ maxPerSeason: 2 });
    assert.equal((await runAutoAdd()).length, 2);
    assert.equal(autoAddedIds().size, 2);
    assert.equal((await autoAddCandidates(cur.season, cur.year)).length, 0, "no room left");
  });

  test("a failing summary notification does not undo or hide the adds", async () => {
    w.fail.ntfy = 500;
    const { value } = await quietWarn(() => runAutoAdd());
    assert.equal(value.length, 3);
    assert.equal(autoAddedIds().size, 3);
  });

  test("disabled, or a bar nobody reaches: nothing is sent to Sonarr", async () => {
    configure({ enabled: false });
    assert.deepEqual(await runAutoAdd(), []);
    configure({ enabled: true, minMatch: 100 });
    invalidateContext();
    assert.deepEqual(await runAutoAdd(), []);
    assert.equal(w.sonarrAdded.length, 0);
  });

  test("a show the user already rated down is never auto-added", async () => {
    const { setFeedback } = await import("../server/services/picks.js");
    setFeedback(301, "disliked");
    const added = await runAutoAdd();
    assert.equal(added.length, 2);
    assert.equal(autoAddedIds().has(301), false);
  });

  test("Sonarr unreachable: nothing is recorded, nothing thrown", async () => {
    w.fail.sonarr = 502;
    invalidateContext();
    const { value } = await quietWarn(() => runAutoAdd());
    assert.deepEqual(value, []);
    assert.equal(autoAddedIds().size, 0);
  });
});
