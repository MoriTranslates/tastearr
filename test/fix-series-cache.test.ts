import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { addPick } from "../server/services/adding.js";
import { invalidateContext } from "../server/services/context.js";
import { clearOverrides, mappingTables } from "../server/services/mapping.js";
import { patchSettings } from "../server/services/settings.js";
import { completeSonarrLibrary, forgetSeries, SERIES_CACHE, sonarrSeries } from "../server/services/sonarr.js";
import {
  addToSeason,
  installWorld,
  newWorld,
  quietWarn,
  resetUserData,
  show,
  SONARR,
  SONARR2,
  writeAnimeList,
  type World,
} from "./world.ts";

/**
 * Fix-branch review #6: while an extra Sonarr is down, display calls (Add preview, show detail, title search) reuse a
 * partial read for a short while instead of waiting on the dead instance every time; add decisions never use it.
 */

let w: World;
let net: ReturnType<typeof installWorld>;
const defaults = { ...SERIES_CACHE };
/** Reads of the extra instance's whole library. */
const extraReads = () => net.calls.filter((c) => c.url.startsWith(`${SONARR2}/api/v3/series`) && !c.url.includes("tvdbId=")).length;

beforeEach(async () => {
  resetUserData();
  w = newWorld();
  net = installWorld(w);
  addToSeason(w, "WINTER", 2030, [show(402)]);
  writeAnimeList([{ anilist_id: 402, tvdb_id: 7001, season: { tvdb: 2 } }]);
  w.sonarrLookup.set(7001, { title: "Star Journey", tvdbId: 7001, year: 2026, seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] });
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: SONARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/tv" },
    sonarrExtra: [{ name: "4K", url: SONARR2, apiKey: "k2" }],
  }));
  clearOverrides();
  await mappingTables();
  w.fail.sonarr2 = 503;
  forgetSeries();
  invalidateContext();
});
afterEach(() => {
  Object.assign(SERIES_CACHE, defaults);
  net.restore();
});

test("display reads reuse a partial library for a short while instead of asking the dead instance again", async () => {
  await quietWarn(() => sonarrSeries());
  await quietWarn(() => sonarrSeries());
  await quietWarn(() => sonarrSeries());
  assert.equal(extraReads(), 1, "the down instance was asked once, not three times");
});

test("callers arriving together share one read", async () => {
  await quietWarn(() => Promise.all([sonarrSeries(), sonarrSeries(), sonarrSeries()]));
  assert.equal(extraReads(), 1);
});

test("after the short partial interval the down instance is checked again", async () => {
  SERIES_CACHE.partialMs = 0;
  await quietWarn(() => sonarrSeries());
  await quietWarn(() => sonarrSeries());
  assert.equal(extraReads(), 2);
});

test("adds never trust the cached partial read: still refused (503) while the instance is down", async () => {
  await quietWarn(() => sonarrSeries()); // a partial read is cached
  await quietWarn(() => assert.rejects(addPick(402, {}), (e: Error & { statusCode?: number }) => e.statusCode === 503));
  await quietWarn(() => assert.rejects(completeSonarrLibrary(), (e: Error & { statusCode?: number }) => e.statusCode === 503));
  assert.equal(w.sonarrAdded.length, 0);
});

test("adds read every instance again instead of using a cached partial read, so a recovered instance counts at once", async () => {
  await quietWarn(() => sonarrSeries()); // partial, cached
  delete w.fail.sonarr2;
  w.sonarr2Series.push({ id: 7, tvdbId: 7001, title: "Star Journey", seasons: [] });
  const lib = await completeSonarrLibrary();
  assert.ok(
    lib.some((x) => x.tvdbId === 7001),
    "the series in the recovered instance is seen as owned",
  );
});
