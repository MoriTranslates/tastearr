import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { setValue } from "../server/data/kv.js";
import { invalidateContext } from "../server/services/context.js";
import { buildProfile, getProfile, PROFILE_RETRY_MS, storedProfile } from "../server/services/profile.js";
import { patchSettings } from "../server/services/settings.js";
import { forgetSeries } from "../server/services/sonarr.js";
import { installWorld, newWorld, quietWarn, RADARR, resetUserData, seedTaste, SONARR, writeAnimeList, type World } from "./world.ts";

/**
 * Fix-branch review #2, in its own file so no earlier failed rebuild (which pauses rebuilds for PROFILE_RETRY_MS) is in
 * the way: a partial profile is rebuilt once the retry pause has passed, not after a whole day like a complete one.
 */

let w: World;
let net: ReturnType<typeof installWorld>;
beforeEach(() => {
  resetUserData();
  setValue("profile", "");
  w = newWorld();
  net = installWorld(w);
  writeAnimeList(seedTaste(w, 3).map((m, i) => ({ anilist_id: m.id, tvdb_id: 5000 + i, season: { tvdb: 1 } })));
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: SONARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/tv" },
    radarr: { ...s.radarr, url: RADARR, apiKey: "k" },
    lists: { anilistUser: "adam", malUser: "", malClientId: "" },
    training: { ...s.training, seasons: 1 },
  }));
  invalidateContext();
  forgetSeries();
});
afterEach(() => net.restore());

const aged = () => Date.now() - PROFILE_RETRY_MS - 60_000; // past the retry pause, far from a day old

test("a partial profile past the retry pause is rebuilt by getProfile, and replaced once every source answers", async () => {
  w.fail.radarr = 500;
  const partial = (await quietWarn(() => buildProfile())).value;
  assert.deepEqual(partial.partial, ["Radarr"]);
  setValue("profile", JSON.stringify({ ...partial, builtAt: aged() }));
  delete w.fail.radarr;
  invalidateContext();
  const p = await getProfile();
  assert.equal(p.partial, undefined);
  assert.ok(p.builtAt > aged());
  assert.equal(storedProfile()?.partial, undefined);
});

test("a complete profile of the same age is still used as it is (rebuilt daily)", async () => {
  const complete = await buildProfile();
  const old = { ...complete, builtAt: aged() };
  setValue("profile", JSON.stringify(old));
  assert.equal((await getProfile()).builtAt, old.builtAt);
});
