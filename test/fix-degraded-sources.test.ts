import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { autoAddedIds, autoAddHistory } from "../server/data/autoadd.js";
import { listJobs } from "../server/data/jobs.js";
import { setValue } from "../server/data/kv.js";
import { addPick } from "../server/services/adding.js";
import { runAutoAdd } from "../server/services/autoadd.js";
import { context, invalidateContext } from "../server/services/context.js";
import { refresh } from "../server/services/jobs.js";
import { clearOverrides, mappingTables } from "../server/services/mapping.js";
import { buildProfile, storedProfile } from "../server/services/profile.js";
import { addMovie } from "../server/services/radarr.js";
import { patchSettings } from "../server/services/settings.js";
import { addSeries, forgetSeries, monitorSeason } from "../server/services/sonarr.js";
import { feedbackFor } from "./cov-feedback.ts";
import {
  installWorld,
  newWorld,
  NTFY,
  quietWarn,
  RADARR,
  resetUserData,
  seedTaste,
  SONARR,
  SONARR2,
  writeAnimeList,
  type World,
} from "./world.ts";

/**
 * Review 2026-11-02, items 1-3 and 8: a Sonarr / extra Sonarr / Radarr / media-server outage must never replace good
 * state with worse state, "couldn't check" must never count as "not owned", an add that finds the series already there
 * must still turn on the requested season, and auto-add's own search switch applies to movies too.
 */

let w: World;
let net: ReturnType<typeof installWorld>;
const job = (name: string) => listJobs().find((j) => j.name === name);
const lookupEntry = (tvdbId: number, title = `Series ${tvdbId}`) => ({
  title,
  tvdbId,
  year: 2026,
  seasons: [
    { seasonNumber: 1, monitored: false },
    { seasonNumber: 2, monitored: false },
  ],
});
const owned = (id: number, tvdbId: number, over: Record<string, unknown> = {}) => ({
  id,
  tvdbId,
  title: `Series ${tvdbId}`,
  monitored: true,
  seriesType: "anime",
  seasons: [
    { seasonNumber: 1, monitored: true },
    { seasonNumber: 2, monitored: false },
  ],
  ...over,
});

const configure = (over: Record<string, unknown> = {}) =>
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: SONARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/tv", searchOnAdd: true },
    sonarrExtra: [],
    radarr: { ...s.radarr, url: "", apiKey: "" },
    media: { type: "none", url: "", token: "", userId: "", libraryIds: [] },
    lists: { anilistUser: "adam", malUser: "", malClientId: "" },
    training: { ...s.training, seasons: 1 },
    notify: { ...s.notify, ntfyUrl: NTFY },
    autoAdd: { ...s.autoAdd, enabled: true, minMatch: 1, newShows: true, sequels: true, movies: false, maxPerSeason: 10, search: false },
    ...over,
  }));

let fresh: ReturnType<typeof seedTaste>;
beforeEach(() => {
  resetUserData();
  setValue("profile", "");
  w = newWorld();
  net = installWorld(w);
  fresh = seedTaste(w, 3);
  writeAnimeList(fresh.map((m, i) => ({ anilist_id: m.id, tvdb_id: 5000 + i, season: { tvdb: 1 } })));
  for (const m of fresh) w.sonarrLookup.set(5000 + (m.id - 300), lookupEntry(5000 + (m.id - 300)));
  // Something in the library, so a healthy build learns from Sonarr.
  w.sonarrSeries.push(owned(1, 4242));
  configure();
  invalidateContext();
  forgetSeries();
});
afterEach(() => net.restore());

describe("item 1: an outage never replaces a good taste profile", () => {
  const outages: [string, () => void][] = [
    ["the main Sonarr is down", () => void (w.fail.sonarr = 503)],
    [
      "an extra Sonarr is down",
      () => {
        configure({ sonarrExtra: [{ name: "4K", url: SONARR2, apiKey: "k2" }] });
        w.fail.sonarr2 = 503;
      },
    ],
    ["Radarr is down", () => void (configure({ radarr: { url: RADARR, apiKey: "k" } }), (w.fail.radarr = 500))],
    // plex.test isn't in the fake world: every request to it fails like an unreachable server.
    [
      "the media server is down",
      () => configure({ media: { type: "plex", url: "http://plex.test:32400", token: "t", userId: "", libraryIds: [] } }),
    ],
  ];
  for (const [name, breakIt] of outages)
    test(`${name}: the stored profile is kept and the profile job fails`, async () => {
      const good = await buildProfile();
      assert.equal(storedProfile()!.builtAt, good.builtAt);
      breakIt();
      invalidateContext();
      forgetSeries();
      await quietWarn(() => assert.rejects(buildProfile(), /Kept the last taste profile because a source couldn't be read/));
      assert.deepEqual(storedProfile(), good, "the good profile was not overwritten");
      const j = job("profile")!;
      assert.equal(j.state, "error");
      assert.match(j.lastError ?? "", /Kept the last taste profile/);
    });

  test("the background refresh reports the kept profile and the skipped auto-add as failures, not success", async () => {
    const good = await buildProfile();
    setValue("profile", JSON.stringify({ ...good, builtAt: 0 })); // old enough to be rebuilt
    const before = storedProfile();
    patchSettings((s) => ({ ...s, auth: { ...s.auth, passwordHash: "set" } })); // the refresh only runs once an account exists
    w.fail.sonarr = 503;
    invalidateContext();
    forgetSeries();
    const warned: string[] = [];
    await quietWarn(() => refresh((m) => warned.push(m)));
    assert.deepEqual(storedProfile(), before, "the stored profile is untouched");
    const r = job("refresh")!;
    assert.equal(r.state, "error");
    assert.match(r.detail, /taste profile: Kept the last taste profile/);
    assert.match(r.detail, /auto-add: Auto-add skipped/);
    assert.equal(w.sonarrAdded.length, 0);
    assert.ok(warned.length);
  });

  test("a healthy context is not marked degraded", async () => {
    const ctx = await context(true);
    assert.deepEqual(ctx.degraded, []);
  });
});

describe("item 2: an unreachable extra Sonarr makes ownership unknown, so nothing is added", () => {
  beforeEach(() => {
    configure({ sonarrExtra: [{ name: "4K", url: SONARR2, apiKey: "k2" }] });
    // The show the user owns lives only in the extra instance.
    w.sonarr2Series.push(owned(7, 5000));
    forgetSeries();
    invalidateContext();
  });

  test("auto-add adds nothing and fails the run while the extra instance is down", async () => {
    w.fail.sonarr2 = 503;
    await quietWarn(() => assert.rejects(runAutoAdd(), /Auto-add skipped.*"4K" unreachable/));
    assert.equal(w.sonarrAdded.length, 0, "no duplicate of the 4K-only show in the main Sonarr");
    assert.equal(autoAddedIds().size, 0);
  });

  test("the context is degraded and says which instance failed", async () => {
    w.fail.sonarr2 = 503;
    const { value: ctx } = await quietWarn(() => context(true));
    assert.equal(ctx.degraded?.length, 1);
    assert.match(ctx.degraded![0], /"4K" unreachable/);
    assert.match(ctx.sources.sonarr, /error: .*"4K" unreachable/);
  });

  test("addSeries refuses (503) instead of adding when an extra instance can't be asked", async () => {
    w.fail.sonarr2 = 503;
    await assert.rejects(
      addSeries(5001, 1),
      (e: Error & { statusCode?: number }) => e.statusCode === 503 && /Nothing was changed/.test(e.message),
    );
    assert.equal(w.sonarrAdded.length, 0);
  });

  test("addSeries finds a series that lives in an extra instance and doesn't add a second copy", async () => {
    const r = await addSeries(5000, 1);
    assert.equal(r.alreadyAdded, true);
    assert.equal(w.sonarrAdded.length, 0);
    assert.equal(w.sonarrPut.length, 1, "season 1 turned on in the instance that has it");
  });

  test("the manual Add button refuses (503) while the extra instance is down", async () => {
    w.fail.sonarr2 = 503;
    await quietWarn(() => assert.rejects(addPick(301, {}), (e: Error & { statusCode?: number }) => e.statusCode === 503));
    assert.equal(w.sonarrAdded.length, 0);
    assert.equal(feedbackFor(301) ?? null, null, "not rated 'added'");
  });

  test("monitorSeason says 'can't tell' rather than 'not in Sonarr' when the series may be in the missing instance", async () => {
    w.fail.sonarr2 = 503;
    await quietWarn(() => assert.rejects(monitorSeason(5000, 2), (e: Error & { statusCode?: number }) => e.statusCode === 503));
  });
});

describe("item 3: 'already in Sonarr' still turns on the requested season", () => {
  test("addSeries for a season of a series already there monitors that season instead of doing nothing", async () => {
    w.sonarrSeries.push(owned(9, 5001));
    w.sonarrLookup.set(5001, lookupEntry(5001));
    const r = await addSeries(5001, 2, { search: true });
    assert.equal(r.alreadyAdded, true);
    assert.equal(r.seasonMonitored, true);
    assert.equal(w.sonarrAdded.length, 0);
    const put = w.sonarrPut.at(-1) as { seasons: { seasonNumber: number; monitored: boolean }[] };
    assert.equal(put.seasons.find((s) => s.seasonNumber === 2)?.monitored, true);
    assert.deepEqual(w.sonarrCommands.at(-1), { name: "SeasonSearch", seriesId: 9, seasonNumber: 2 });
  });

  test("auto-add deciding from a library that changed meanwhile: the season is turned on and recorded", async () => {
    // Sonarr's list said "not there" when auto-add decided; by the add, another client had added the series.
    const entry = lookupEntry(5000);
    const real = w.sonarrLookup;
    w.sonarrLookup = new Map(real);
    w.sonarrLookup.get = (id: number) => {
      if (id === 5000 && !w.sonarrSeries.some((x) => x.tvdbId === 5000))
        w.sonarrSeries.push(owned(55, 5000, { seasons: [{ seasonNumber: 1, monitored: false }] }));
      return id === 5000 ? entry : real.get(id);
    };
    await runAutoAdd();
    assert.ok(!w.sonarrAdded.some((s) => s.tvdbId === 5000), "not added a second time");
    const put = w.sonarrPut.find((x) => x.id === 55) as { seasons: { seasonNumber: number; monitored: boolean }[] };
    assert.equal(put.seasons[0].monitored, true, "season 1 turned on");
    assert.ok(autoAddedIds().has(300));
    const row = (autoAddHistory() as { id: number; detail: string }[]).find((h) => h.id === 300);
    assert.match(row?.detail ?? "", /already in sonarr, season 1 turned on/);
  });

  test("auto-add finding the series already there with nothing to turn on does not record it as done", async () => {
    writeAnimeList(fresh.map((m, i) => ({ anilist_id: m.id, tvdb_id: 5000 + i }))); // season unknown
    const entry = lookupEntry(5000);
    const real = w.sonarrLookup;
    w.sonarrLookup = new Map(real);
    w.sonarrLookup.get = (id: number) => {
      if (id === 5000 && !w.sonarrSeries.some((x) => x.tvdbId === 5000)) w.sonarrSeries.push(owned(56, 5000));
      return id === 5000 ? entry : real.get(id);
    };
    clearOverrides(); // reload the list written above
    await mappingTables();
    invalidateContext();
    const added = await runAutoAdd();
    assert.ok(
      w.sonarrSeries.some((x) => x.id === 56),
      "the add was attempted (and found the series)",
    );
    assert.ok(!added.some((a) => a.title.startsWith("Journey 0")));
    assert.equal(autoAddedIds().has(300), false, "a no-op is not 'auto-added once ever'");
    assert.equal(feedbackFor(300) ?? null, null);
  });
});

describe("item 8: auto-add's search switch applies to movies", () => {
  test("addMovie passes an explicit search choice over Radarr's own setting", async () => {
    configure({
      radarr: {
        url: RADARR,
        apiKey: "k",
        qualityProfileId: 4,
        rootFolderPath: "/movies",
        tags: [],
        searchOnAdd: true,
        minimumAvailability: "released",
      },
    });
    w.radarrLookup.set(77, { tmdbId: 77, title: "Film" });
    w.radarrLookup.set(78, { tmdbId: 78, title: "Film 2" });
    await addMovie({ tmdbId: 77 }, { search: false });
    assert.deepEqual((w.radarrAdded.at(-1) as { addOptions: unknown }).addOptions, { searchForMovie: false });
    await addMovie({ tmdbId: 78 });
    assert.deepEqual((w.radarrAdded.at(-1) as { addOptions: unknown }).addOptions, { searchForMovie: true }, "default: Radarr's setting");
  });
});
