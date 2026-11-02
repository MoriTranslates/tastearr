import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { addPick, matchCandidates, monitorPick, planForPick } from "../server/services/adding.js";
import { invalidateContext } from "../server/services/context.js";
import { clearOverrides, mapAnilist, mappingTables } from "../server/services/mapping.js";
import { patchSettings } from "../server/services/settings.js";
import { forgetSeries } from "../server/services/sonarr.js";
import { feedbackFor } from "./cov-feedback.ts";
import { addToSeason, installWorld, newWorld, RADARR, resetUserData, show, SONARR, SONARR2, writeAnimeList, type World } from "./world.ts";

/**
 * The Add / Monitor buttons (services/adding.ts) end to end over a fake Sonarr and Radarr: previews, title matches,
 * adds and monitors, and the failure paths (Sonarr or Radarr down, an add failing halfway, adding twice, an
 * unreachable extra Sonarr).
 */

let w: World;
let net: ReturnType<typeof installWorld>;
const status = (code: number, msg?: RegExp) => (e: Error & { statusCode?: number }) =>
  e.statusCode === code && (!msg || msg.test(e.message));
const lookupEntry = (tvdbId: number, title: string, seasons = [1, 2]) => ({
  title,
  tvdbId,
  year: 2026,
  seasons: seasons.map((seasonNumber) => ({ seasonNumber, monitored: false })),
});
const owned = (id: number, tvdbId: number, title: string) => ({
  id,
  tvdbId,
  title,
  monitored: true,
  seriesType: "anime",
  seasons: [
    { seasonNumber: 1, monitored: true },
    { seasonNumber: 2, monitored: false },
  ],
});

// AniList entries: 401 a new show (TVDB 7001 season 1), 402 its sequel (season 2), 403 unmapped with 402 as prequel,
// 404 a movie with a TMDB id, 405 a movie with no ids, 406 a "Part 2" of 402, 407 unmapped with no prequel.
const SHOWS = {
  first: show(401, { title: { romaji: "Hoshi no Tabi", english: "Star Journey", native: null } }),
  sequel: show(402, { title: { romaji: "Hoshi no Tabi 2", english: "Star Journey Season 2", native: null } }),
  unmapped: show(403, {
    title: { romaji: "Hoshi no Tabi 3", english: "Star Journey Season 3", native: null },
    relations: { edges: [{ relationType: "PREQUEL", node: { id: 402, type: "ANIME", format: "TV" } }] },
  }),
  movie: show(404, { format: "MOVIE", title: { romaji: "Eiga", english: "The Movie", native: null } }),
  lostMovie: show(405, { format: "MOVIE", title: { romaji: "Eiga 2", english: "Lost Movie", native: null } }),
  part2: show(406, {
    title: { romaji: "Hoshi no Tabi 2 Part 2", english: "Star Journey Season 2 Part 2", native: null },
    relations: { edges: [{ relationType: "PREQUEL", node: { id: 402, type: "ANIME", format: "TV" } }] },
  }),
  orphan: show(407, { title: { romaji: "Kumo", english: "Clouds", native: null } }),
};

beforeEach(async () => {
  resetUserData();
  w = newWorld();
  net = installWorld(w);
  addToSeason(w, "WINTER", 2030, Object.values(SHOWS));
  writeAnimeList([
    { anilist_id: 401, tvdb_id: 7001, season: { tvdb: 1 } },
    { anilist_id: 402, tvdb_id: 7001, season: { tvdb: 2 } },
    { anilist_id: 404, themoviedb_id: { movie: 77 }, imdb_id: "tt0077" },
    { anilist_id: 405 },
  ]);
  w.sonarrLookup.set(7001, lookupEntry(7001, "Star Journey", [1, 2, 3]));
  w.sonarrLookup.set(7002, lookupEntry(7002, "Clouds Over Tokyo", [1]));
  w.radarrLookup.set(77, { tmdbId: 77, title: "The Movie" });
  patchSettings((s) => ({
    ...s,
    sonarr: {
      ...s.sonarr,
      url: SONARR,
      apiKey: "k",
      qualityProfileId: 4,
      rootFolderPath: "/tv",
      searchOnAdd: false,
      sequelMonitor: "newSeason",
    },
    sonarrExtra: [],
    radarr: { ...s.radarr, url: RADARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/movies", searchOnAdd: true, tags: [] },
  }));
  clearOverrides();
  await mappingTables();
  forgetSeries();
  invalidateContext();
});
afterEach(() => net.restore());

describe("planForPick (the confirm dialog)", () => {
  test("a movie: Radarr's folder and search setting; an unmatched movie is a 422", async () => {
    const p = await planForPick(404);
    assert.deepEqual(p, {
      app: "radarr",
      title: "The Movie",
      rootFolder: "/movies",
      search: true,
      minimumAvailability: p.minimumAvailability,
    });
    await assert.rejects(planForPick(405), status(422, /isn't matched to TMDB or IMDb/));
  });

  test("a mapped sequel: only its season by default, with the series' seasons for a hand pick", async () => {
    const p = await planForPick(402);
    assert.equal(p.app, "sonarr");
    assert.equal((p as { monitor: string }).monitor, "season");
    assert.equal((p as { season: number }).season, 2);
    assert.deepEqual((p as { seasons: number[] }).seasons, [1, 2, 3]);
    assert.equal((p as { resumesSeries: boolean }).resumesSeries, false, "not in Sonarr: nothing to resume");
  });

  test("unmapped: the dialog asks for a match", async () => {
    assert.deepEqual(await planForPick(407), { app: "sonarr", needsMatch: true });
  });

  test("a picked title-search match: season guessed from the prequel's mapping; a split cour keeps the prequel's season", async () => {
    w.sonarrSeries.push({ ...owned(31, 7001, "Star Journey"), monitored: false });
    const p = (await planForPick(403, "7001")) as { season: number; alreadyInLibrary: boolean; resumesSeries: boolean };
    assert.equal(p.season, 3, "one past season 2");
    assert.equal(p.alreadyInLibrary, true);
    assert.equal(p.resumesSeries, true, "the series is unmonitored: monitoring would switch it back on");
    const split = (await planForPick(406, "7001")) as { season: number };
    assert.equal(split.season, 2, "TVDB files a Part 2 under the same season");
    const asked = (await planForPick(403, "7001", "1")) as { season: number };
    assert.equal(asked.season, 1, "an explicit season wins");
  });

  test("bad ids are 400s, unknown shows 404", async () => {
    await assert.rejects(planForPick(403, "abc"), status(400));
    await assert.rejects(planForPick(999_999), status(404, /Unknown show/));
  });
});

describe("matchCandidates", () => {
  test("Sonarr's title search, best match first, marking what is already in Sonarr", async () => {
    w.sonarrSeries.push(owned(31, 7001, "Star Journey"));
    const c = await matchCandidates(403);
    assert.equal(c[0].tvdbId, 7001);
    assert.equal(c[0].inLibrary, true);
  });
});

describe("addPick", () => {
  test("a movie goes to Radarr and is rated 'added'; Radarr down is an error and nothing is rated", async () => {
    w.fail.radarr = 503;
    await assert.rejects(addPick(404, {}), /HTTP 503/);
    assert.equal(feedbackFor(404) ?? null, null);
    delete w.fail.radarr;
    const r = await addPick(404, {});
    assert.equal((r as { alreadyAdded: boolean }).alreadyAdded, false);
    assert.equal(w.radarrAdded.length, 1);
    assert.equal(feedbackFor(404), "added");
  });

  test("a movie Radarr can't find is a 404", async () => {
    await assert.rejects(addPick(405, {}), status(404, /Radarr couldn't find/));
    assert.equal(w.radarrAdded.length, 0);
  });

  test("adding a movie twice doesn't add it twice", async () => {
    await addPick(404, {});
    w.radarrMovies.push({ id: 2001, tmdbId: 77, title: "The Movie" });
    const again = await addPick(404, {});
    assert.equal((again as { alreadyAdded: boolean }).alreadyAdded, true);
    assert.equal(w.radarrAdded.length, 1);
  });

  test("a mapped show not in Sonarr is added with the chosen monitoring; adding it again doesn't create a second copy", async () => {
    const r = await addPick(402, { monitor: "season" });
    assert.equal(r.title, "Star Journey");
    assert.equal(w.sonarrAdded.length, 1);
    const sent = w.sonarrAdded[0] as { seasons: { seasonNumber: number; monitored: boolean }[] };
    assert.deepEqual(
      sent.seasons.filter((s) => s.monitored).map((s) => s.seasonNumber),
      [2],
    );
    assert.equal(feedbackFor(402), "added");
    // Sonarr now has it; a second press (double click, a retry) monitors instead of adding again.
    w.sonarrSeries.push(owned(1001, 7001, "Star Journey"));
    forgetSeries();
    const again = await addPick(402, {});
    assert.equal(w.sonarrAdded.length, 1, "no duplicate add");
    assert.equal((again as { season: number }).season, 2);
  });

  test("a mapped show already in Sonarr: its season is monitored; without a season number it's a 409", async () => {
    w.sonarrSeries.push(owned(31, 7001, "Star Journey"));
    const r = await addPick(402, {});
    assert.equal((r as { season: number }).season, 2);
    assert.equal(w.sonarrAdded.length, 0);
    assert.equal((w.sonarrPut.at(-1) as { seasons: { seasonNumber: number; monitored: boolean }[] }).seasons[1].monitored, true);
    writeAnimeList([{ anilist_id: 402, tvdb_id: 7001 }]);
    clearOverrides();
    await mappingTables();
    forgetSeries();
    await assert.rejects(addPick(402, {}), status(409, /already in Sonarr/));
  });

  test("unmapped with no match picked: 422", async () => {
    await assert.rejects(addPick(407, {}), status(422, /Pick the matching show first/));
  });

  test("a picked match must be one of Sonarr's own results", async () => {
    await assert.rejects(addPick(407, { tvdbId: 7001 }), status(422, /isn't one of Sonarr's matches/));
    assert.equal(w.sonarrAdded.length, 0);
  });

  test("a picked match not in Sonarr is added and remembered", async () => {
    const r = await addPick(407, { tvdbId: "7002", season: 1 });
    assert.equal(r.title, "Clouds Over Tokyo");
    assert.equal(w.sonarrAdded.length, 1);
    assert.deepEqual(await mapAnilist(407), { tvdbId: 7002, season: 1 });
  });

  test("a picked match already in Sonarr: monitors the asked season; without any season it asks (422)", async () => {
    w.sonarrSeries.push(owned(31, 7001, "Star Journey"));
    const r = await addPick(403, { tvdbId: 7001, season: "3" });
    assert.equal((r as { season: number }).season, 3);
    assert.deepEqual(await mapAnilist(403), { tvdbId: 7001, season: 3 });
    w.sonarrLookup.set(7003, lookupEntry(7003, "Clouds", [1]));
    w.sonarrSeries.push(owned(32, 7003, "Clouds"));
    forgetSeries();
    await assert.rejects(addPick(407, { tvdbId: 7003 }), status(422, /Choose which season/));
  });

  test("an add failing halfway (Sonarr refuses the POST) leaves no match, no rating, nothing added", async () => {
    w.failAddFor.add(7002);
    await assert.rejects(addPick(407, { tvdbId: 7002, season: 1 }), /HTTP 500/);
    assert.equal(await mapAnilist(407), null, "the match is only remembered once Sonarr took it");
    assert.equal(feedbackFor(407) ?? null, null);
    assert.equal(w.sonarrAdded.length, 0);
  });

  test("the main Sonarr down: an error, nothing rated", async () => {
    w.fail.sonarr = 502;
    await assert.rejects(addPick(402, {}), /HTTP 502/);
    assert.equal(feedbackFor(402) ?? null, null);
  });

  test("an extra Sonarr down: refused with 503 (it may already have the show)", async () => {
    patchSettings((s) => ({ ...s, sonarrExtra: [{ name: "4K", url: SONARR2, apiKey: "k2" }] }));
    w.fail.sonarr2 = 503;
    forgetSeries();
    await assert.rejects(addPick(402, {}), status(503, /"4K" unreachable/));
    await assert.rejects(addPick(407, { tvdbId: 7002, season: 1 }), status(503));
    assert.equal(w.sonarrAdded.length, 0);
  });
});

describe("monitorPick", () => {
  test("monitors the mapped season of a series in Sonarr; an unknown season is a 422", async () => {
    w.sonarrSeries.push(owned(31, 7001, "Star Journey"));
    const r = await monitorPick(402, false);
    assert.equal(r.season, 2);
    assert.equal(w.sonarrCommands.length, 0, "no search when asked not to");
    assert.equal(feedbackFor(402), "added");
    await assert.rejects(monitorPick(407), status(422, /Unknown season/));
  });
});
