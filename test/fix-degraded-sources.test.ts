import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { autoAddedIds, autoAddHistory } from "../server/data/autoadd.js";
import { listJobs } from "../server/data/jobs.js";
import { setValue } from "../server/data/kv.js";
import { addPick } from "../server/services/adding.js";
import { autoAddCandidates, runAutoAdd } from "../server/services/autoadd.js";
import { context, invalidateContext } from "../server/services/context.js";
import { refresh } from "../server/services/jobs.js";
import { clearOverrides, mappingTables } from "../server/services/mapping.js";
import { warnings } from "../server/services/health.js";
import { buildProfile, getProfile, rebuildProfile, storedProfile } from "../server/services/profile.js";
import { addMovie } from "../server/services/radarr.js";
import { patchSettings } from "../server/services/settings.js";
import { addSeries, forgetSeries, monitorSeason, sonarrSeries } from "../server/services/sonarr.js";
import { feedbackFor } from "./cov-feedback.ts";
import { seasonOf, shiftSeason } from "../server/core/taste/media.js";
import { seasonAnnounced } from "../server/data/library.js";
import { notifySeason } from "../server/services/notify.js";
import {
  addToSeason,
  installWorld,
  newWorld,
  NTFY,
  quietWarn,
  RADARR,
  resetUserData,
  seedTaste,
  show,
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

describe("fix review #2: a provisional profile when there is nothing to keep, and a source that stays down is pointed out", () => {
  const cur = seasonOf();
  const radarrDown = () => {
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
      notify: { ntfyUrl: NTFY, discordWebhook: "", gotifyUrl: "", gotifyToken: "", seasonAlerts: true, picks: 2 },
    });
    w.fail.radarr = 500;
    invalidateContext();
  };

  test("a fresh install with Radarr returning 500 gets a partial profile instead of none, and the job doesn't report success", async () => {
    radarrDown();
    assert.equal(storedProfile(), null, "fresh install");
    const p = await quietWarn(() => buildProfile());
    assert.deepEqual(p.value.partial, ["Radarr"]);
    assert.deepEqual(storedProfile()?.partial, ["Radarr"]);
    assert.ok((await getProfile()).features, "picks have a profile to work with");
    const j = job("profile")!;
    assert.equal(j.state, "error");
    assert.match(j.detail, /partial taste profile without Radarr/);
    assert.ok(
      warnings().some((x) => /taste profile is partial: Radarr couldn't be read/.test(x)),
      "the banner says so",
    );
  });

  test("the partial profile never feeds auto-add or the season alert, even once every source answers again", async () => {
    radarrDown();
    await quietWarn(() => buildProfile());
    delete w.fail.radarr; // back up, but the provisional profile is still fresh
    invalidateContext();
    await quietWarn(() => assert.rejects(runAutoAdd(), /Auto-add skipped: the taste profile is partial \(built without Radarr\)/));
    assert.equal(w.sonarrAdded.length, 0);
    assert.equal(autoAddedIds().size, 0);
    await quietWarn(() => assert.rejects(notifySeason(cur.season, cur.year, true), /Season alert skipped: the taste profile is partial/));
    assert.equal(w.ntfySent.filter((m) => /anime picks/.test(m.title)).length, 0);
    assert.equal(seasonAnnounced(cur.season, cur.year), false);
  });

  test("the first complete build replaces the partial profile", async () => {
    radarrDown();
    const partial = (await quietWarn(() => buildProfile())).value;
    delete w.fail.radarr;
    invalidateContext();
    // The next build (the refresh, or getProfile once the retry pause has passed) is complete and replaces it.
    const p = await rebuildProfile();
    assert.equal(p.partial, undefined, "complete");
    assert.deepEqual(await getProfile(), p, "and it is the one used from now on");
    assert.ok(p.builtAt > partial.builtAt);
    assert.equal(storedProfile()?.partial, undefined);
    assert.equal(job("profile")!.state, "done");
    assert.ok(!warnings().some((x) => /partial/.test(x)));
    // From now on a source going down keeps this complete profile instead of replacing it.
    w.fail.radarr = 500;
    invalidateContext();
    await quietWarn(() => assert.rejects(buildProfile(), /Kept the last taste profile/));
    assert.equal(storedProfile()?.builtAt, p.builtAt);
  });

  test("an extra Sonarr that stays down is named in a warning pointing to Settings, and the warning clears when it answers", async () => {
    await buildProfile();
    configure({ sonarrExtra: [{ name: "4K", url: SONARR2, apiKey: "k2" }] });
    w.fail.sonarr2 = 503;
    invalidateContext();
    forgetSeries();
    await quietWarn(() => context(true));
    const w4k = warnings().find((x) => x.includes('Sonarr "4K"'));
    assert.ok(w4k, warnings().join(" | "));
    assert.match(w4k, /couldn't be read since \d{4}-\d{2}-\d{2}, so your taste profile isn't being updated .* Settings → Connections/);
    delete w.fail.sonarr2;
    invalidateContext();
    forgetSeries();
    await context(true);
    assert.ok(!warnings().some((x) => x.includes('Sonarr "4K"')));
  });
});

describe("fix review #11: auto-add decides from the context it checked", () => {
  test("a forced context never joins a non-forced build that may reuse a library list cached minutes ago", async () => {
    await sonarrSeries(); // the library list is cached
    w.sonarrSeries.push(owned(70, 5001)); // added in Sonarr since
    invalidateContext();
    const [page, fresh] = await Promise.all([context(), context(true)]);
    assert.equal(page.lib.has(5001), false, "the page's build used the cached list (fine for display)");
    assert.equal(fresh.lib.has(5001), true, "the forced build read Sonarr again");
  });

  test("candidates come from the checked context, not from one built in between", async () => {
    await buildProfile();
    w.sonarrSeries.push(owned(71, 5000, { seasons: [{ seasonNumber: 1, monitored: false }] }));
    invalidateContext();
    forgetSeries();
    const checked = await context(true); // what auto-add checked: show 300 (TVDB 5000) is owned
    // Meanwhile the library view changes (here: the series disappears) and the cache is invalidated.
    w.sonarrSeries = w.sonarrSeries.filter((x) => x.tvdbId !== 5000);
    invalidateContext();
    forgetSeries();
    const cands = await autoAddCandidates(seasonOf().season, seasonOf().year, checked);
    const p300 = cands.find((c) => c.id === 300);
    assert.notEqual(p300?.autoAction, "add", "decided from the checked context, where it is owned");
  });
});

describe("fix review #13: auto-add failures don't leave the refresh 'done'", () => {
  test("two of three adds fail (Sonarr refuses them): the refresh reports it, naming the shows, and the one that worked is kept", async () => {
    await buildProfile();
    patchSettings((s) => ({ ...s, auth: { ...s.auth, passwordHash: "set" } }));
    w.failAddFor.add(5001);
    w.failAddFor.add(5002);
    invalidateContext();
    forgetSeries();
    await quietWarn(() => refresh(() => undefined));
    const r = job("refresh")!;
    assert.equal(r.state, "error", "not shown as a plain success");
    assert.match(r.detail, /auto-add: 2 of 3 shows failed \(retried next run\): Journey [12]: .*; Journey [12]: /);
    assert.deepEqual([...autoAddedIds()], [300], "the add that worked is recorded");
  });
});

describe("fix review #4: the refresh's profile step fails inside the retry pause too", () => {
  test("Sonarr down: a rebuild failed minutes ago (Picks opened), then the refresh runs; its profile step reports the failure", async () => {
    const good = await buildProfile();
    setValue("profile", JSON.stringify({ ...good, builtAt: 0 })); // due for a rebuild
    configure({ autoAdd: { enabled: false } });
    patchSettings((s) => ({ ...s, auth: { ...s.auth, passwordHash: "set" } }));
    w.fail.sonarr = 503;
    invalidateContext();
    forgetSeries();
    // Picks: a non-strict caller. The rebuild fails, the old profile is used, and rebuilds pause for PROFILE_RETRY_MS.
    const used = await quietWarn(() => getProfile());
    assert.equal(used.value.builtAt, 0);
    // The refresh within that pause: strict must not quietly take the old profile.
    await quietWarn(() => assert.rejects(getProfile(undefined, { strict: true }), /Kept the last taste profile/));
    await quietWarn(() => refresh(() => undefined));
    const r = job("refresh")!;
    assert.equal(r.state, "error");
    assert.match(r.detail, /taste profile: Kept the last taste profile because a source couldn't be read/);
  });
});

describe("fix review #1: no season alert from an incomplete context", () => {
  const cur = seasonOf();
  beforeEach(() => {
    // Show 300 ("Journey 0", TVDB 5000) is already in Sonarr; 301 and 302 are new.
    w.sonarrSeries.push(owned(60, 5000));
    configure({ notify: { ntfyUrl: NTFY, discordWebhook: "", gotifyUrl: "", gotifyToken: "", seasonAlerts: true, picks: 2 } });
    invalidateContext();
    forgetSeries();
  });
  const seasonMessages = () => w.ntfySent.filter((m) => /anime picks/.test(m.title));

  test("Sonarr down (503): the alert is refused, nothing is sent, and the season is not marked announced", async () => {
    await buildProfile(); // a good profile exists; only the library is missing
    w.fail.sonarr = 503;
    invalidateContext();
    forgetSeries();
    await quietWarn(() =>
      assert.rejects(notifySeason(cur.season, cur.year, true), /Season alert skipped because a source couldn't be read: sonarr/),
    );
    assert.equal(seasonMessages().length, 0, "nothing sent that could list owned shows");
    assert.equal(seasonAnnounced(cur.season, cur.year), false, "the correct alert can still go out later");

    delete w.fail.sonarr;
    invalidateContext();
    forgetSeries();
    assert.equal(await notifySeason(cur.season, cur.year, true), true);
    assert.equal(seasonMessages().length, 1);
    assert.doesNotMatch(seasonMessages()[0].message, /Journey 0/, "the owned show is left out once Sonarr answers");
    assert.equal(seasonAnnounced(cur.season, cur.year), true);
  });

  test("the background refresh skips picks and the season alert after the profile step met a source that was down", async () => {
    await buildProfile();
    patchSettings((s) => ({ ...s, auth: { ...s.auth, passwordHash: "set" } }));
    // The refresh announces next season: give it a line-up there too.
    const next = shiftSeason(cur, 1);
    addToSeason(
      w,
      next.season,
      next.year,
      [400, 401, 402].map((id) => show(id, { season: next.season, seasonYear: next.year })),
    );
    w.fail.sonarr = 503;
    invalidateContext();
    forgetSeries();
    await quietWarn(() => refresh(() => undefined));
    assert.equal(seasonMessages().length, 0);
    assert.equal(seasonAnnounced(next.season, next.year), false);
    const r = job("refresh")!;
    assert.equal(r.state, "error");
    assert.match(r.detail, /picks and season alert: skipped because a source couldn't be read: sonarr/);
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
