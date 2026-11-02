import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { seasonOf, shiftSeason } from "../server/core/taste/media.js";
import { listJobs } from "../server/data/jobs.js";
import { invalidateContext } from "../server/services/context.js";
import { importAnilist, listEntries } from "../server/services/lists.js";
import { buildProfile, getProfile, rebuildProfile, storedProfile } from "../server/services/profile.js";
import { recommend, setFeedback } from "../server/services/picks.js";
import { patchSettings } from "../server/services/settings.js";
import { addToSeason, installWorld, newWorld, quietWarn, resetUserData, SONARR, show, writeAnimeList, type World } from "./world.ts";
import { tags } from "./helpers.ts";

/** Profile build and picks refresh end to end over a fake AniList/Sonarr, including one source failing. */

const cur = seasonOf();
const prev = shiftSeason(cur, -1);
let w: World;
let net: ReturnType<typeof installWorld>;

/** 14 loved fantasy shows last season, 14 unloved romances, 4 fantasy candidates and 2 romances this season. */
function seed() {
  const loved = Array.from({ length: 14 }, (_, i) =>
    show(100 + i, { season: prev.season, seasonYear: prev.year, genres: ["Fantasy"], tags: tags("Isekai", "Magic") }),
  );
  const other = Array.from({ length: 14 }, (_, i) =>
    show(200 + i, { season: prev.season, seasonYear: prev.year, genres: ["Romance"], tags: tags("School", "Love Triangle") }),
  );
  addToSeason(w, prev.season, prev.year, [...loved, ...other]);
  w.anilistList = loved.map((m) => ({ mediaId: m.id, status: "COMPLETED", score: 90, progress: 12 }));
  const fresh = [
    show(300, { title: { romaji: "Mahou no Tabi", english: "Magic Journey", native: "魔法の旅" }, season: cur.season, seasonYear: cur.year }),
    show(301, { season: cur.season, seasonYear: cur.year }),
    show(302, { genres: ["Romance"], tags: tags("School", "Love Triangle"), season: cur.season, seasonYear: cur.year }),
    show(303, { season: cur.season, seasonYear: cur.year }),
  ];
  addToSeason(w, cur.season, cur.year, fresh);
}

beforeEach(() => {
  resetUserData();
  w = newWorld();
  net = installWorld(w);
  seed();
  patchSettings((s) => ({
    ...s,
    training: { ...s.training, seasons: 1 },
    lists: { anilistUser: "adam", malUser: "", malClientId: "" },
    sonarr: { ...s.sonarr, url: "", apiKey: "" },
  }));
  writeAnimeList([]);
  invalidateContext();
});
afterEach(() => net.restore());

describe("profile build", () => {
  test("learns from list + season data, saves the profile and marks the job done", async () => {
    const p = await buildProfile();
    assert.ok(p.known >= 14, `known ${p.known}`);
    assert.ok(p.features["G:Fantasy"], "fantasy learned");
    assert.ok(p.features["G:Fantasy"].lift > (p.features["G:Romance"]?.lift ?? 0), "loved genre ranks above ignored genre");
    assert.equal(storedProfile()?.builtAt, p.builtAt);
    const job = listJobs().find((j) => j.name === "profile")!;
    assert.equal(job.state, "done");
    assert.equal(listEntries().length, 14, "the user's AniList list was imported on the way");
  });

  test("save:false builds without touching the database", async () => {
    const before = storedProfile();
    const p = await buildProfile({ save: false });
    assert.ok(p.trainedOn > 0);
    assert.equal(listEntries().length, 0, "lists are not imported either");
    assert.deepEqual(storedProfile(), before);
  });

  test("a failing list import is a warning, not a failed build", async () => {
    await importAnilist("adam");
    w.fail.anilistList = 500;
    const { value: p, warnings } = await quietWarn(() => buildProfile());
    assert.ok(p.trainedOn > 0);
    assert.equal(listEntries().length, 14, "the earlier import is kept when the refresh fails");
    assert.ok(warnings.some((x) => /List import failed/.test(x)));
    assert.equal(listJobs().find((j) => j.name === "profile")!.state, "done");
  });

  test("AniList season download failing marks the job as error and keeps the previous profile", async () => {
    const good = await buildProfile();
    w.fail.anilistSeason = 503;
    // The season is cached from the first build; ask for a season that is not.
    patchSettings((s) => ({ ...s, training: { ...s.training, seasons: 3 } }));
    await assert.rejects(buildProfile(), /having trouble/);
    const job = listJobs().find((j) => j.name === "profile")!;
    assert.equal(job.state, "error");
    assert.match(job.detail ?? "", /having trouble/);
    assert.equal(storedProfile()!.builtAt, good.builtAt, "old profile untouched");
  });

  test("concurrent rebuilds share one build; getProfile reuses a fresh stored profile", async () => {
    const [a, b] = await Promise.all([rebuildProfile(), rebuildProfile()]);
    assert.equal(a, b);
    const calls = net.calls.length;
    assert.equal((await getProfile()).builtAt, a.builtAt);
    assert.equal(net.calls.length, calls, "no network for a fresh profile");
  });
});

describe("picks refresh", () => {
  test("scores a season: loved genre first, disliked excluded, CJK titles intact, sorted by match", async () => {
    await buildProfile();
    setFeedback(303, "disliked");
    const { picks } = await recommend(cur.season, cur.year);
    assert.equal(picks.length, 4);
    for (let i = 1; i < picks.length; i++) assert.ok(picks[i - 1].match >= picks[i].match, "sorted by match");
    assert.ok(picks.find((p) => p.id === 300)!.match > picks.find((p) => p.id === 302)!.match, "fantasy beats romance");
    assert.equal(picks.find((p) => p.id === 300)!.title, "Magic Journey");
    assert.equal(picks.find((p) => p.id === 300)!.altTitle, "Mahou no Tabi");
    assert.match(picks.find((p) => p.id === 303)!.excluded ?? "", /👎/);
    assert.ok(picks.every((p) => p.match >= 0 && p.match <= 100));
  });

  test("Sonarr being down degrades to picks without library data instead of failing", async () => {
    await buildProfile();
    patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, url: SONARR, apiKey: "k" } }));
    invalidateContext();
    w.fail.sonarr = 500;
    const { value } = await quietWarn(() => recommend(cur.season, cur.year, true));
    assert.equal(value.picks.length, 4);
  });

  test("an empty season gives an empty list, not an error", async () => {
    await buildProfile();
    const next = shiftSeason(cur, 1);
    const { picks } = await recommend(next.season, next.year);
    assert.deepEqual(picks, []);
  });

  test("the season fetch failing surfaces an error the caller can show", async () => {
    await buildProfile();
    const far = shiftSeason(cur, 3);
    w.fail.anilistSeason = 502;
    await assert.rejects(recommend(far.season, far.year), /having trouble/);
  });

  test("a 👎 given in Picks is remembered in the cached context straight away", async () => {
    await buildProfile();
    const first = await recommend(cur.season, cur.year);
    assert.equal(first.picks.find((p) => p.id === 301)!.excluded, null);
    setFeedback(301, "hidden");
    const again = await recommend(cur.season, cur.year);
    assert.match(again.picks.find((p) => p.id === 301)!.excluded ?? "", /hid/);
    setFeedback(301, null);
    assert.equal((await recommend(cur.season, cur.year)).picks.find((p) => p.id === 301)!.excluded, null);
  });
});
