import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ANILIST_LIMITS, inBackground } from "../server/adapters/anilist.js";
import { setValue } from "../server/data/kv.js";
import { invalidateContext } from "../server/services/context.js";
import { buildProfile, getProfile, isBuilding, rebuildProfile, storedProfile } from "../server/services/profile.js";
import { getQuiz, prewarmQuiz } from "../server/services/quiz.js";
import { patchSettings } from "../server/services/settings.js";
import { installWorld, newWorld, resetUserData, seedTaste, writeAnimeList, type World } from "./world.ts";

/**
 * Fix-branch review #10: a page that joins work started in the background lane (the quiz prewarm, a profile rebuild)
 * used to inherit the background's patience (up to 120 s per rate-limit pause). It now waits at most the interactive
 * deadline, then gets the existing profile or a "still being prepared" answer, while the work carries on.
 */

let w: World;
let net: ReturnType<typeof installWorld>;
let restoreSlow = () => undefined as void;
const defaults = { ...ANILIST_LIMITS };
const realSetTimeout = globalThis.setTimeout;
const pause = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

/** Every AniList answer takes 250 ms (under the 300 ms the fake world would make instant), so a build takes a while. */
function slowAniList() {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).includes("graphql.anilist.co")) await pause(250);
    return inner(input, init);
  }) as typeof fetch;
  restoreSlow = () => void (globalThis.fetch = inner);
}

beforeEach(() => {
  resetUserData();
  setValue("profile", "");
  w = newWorld();
  net = installWorld(w);
  writeAnimeList(seedTaste(w, 3).map((m, i) => ({ anilist_id: m.id, tvdb_id: 5000 + i, season: { tvdb: 1 } })));
  patchSettings((s) => ({ ...s, lists: { anilistUser: "adam", malUser: "", malClientId: "" }, training: { ...s.training, seasons: 2 } }));
  invalidateContext();
});
afterEach(async () => {
  restoreSlow();
  Object.assign(ANILIST_LIMITS, defaults);
  while (isBuilding()) await pause(20);
  net.restore();
});

test("a page asking for the profile while a background rebuild runs gets the existing profile within the interactive deadline", async () => {
  const old = await buildProfile();
  setValue("profile", JSON.stringify({ ...old, builtAt: 1 })); // due for a rebuild
  slowAniList();
  Object.assign(ANILIST_LIMITS, { interactiveTotalMs: 150 });
  const t = Date.now();
  const p = await getProfile();
  const waited = Date.now() - t;
  assert.equal(p.builtAt, 1, "the stored profile, not a wait for the rebuild");
  assert.ok(waited < 450, `waited ${waited} ms`);
  while (isBuilding()) await pause(20);
  assert.ok(storedProfile()!.builtAt > 1, "the rebuild carried on in the background and was saved");
});

test("a background caller still waits for the whole rebuild", async () => {
  const old = await buildProfile();
  setValue("profile", JSON.stringify({ ...old, builtAt: 1 }));
  slowAniList();
  Object.assign(ANILIST_LIMITS, { interactiveTotalMs: 150 });
  const p = await inBackground(() => rebuildProfile());
  assert.ok(p.builtAt > 1);
});

test("opening the quiz while the startup prewarm builds the pool answers 'still being prepared' instead of hanging", async () => {
  slowAniList();
  Object.assign(ANILIST_LIMITS, { interactiveTotalMs: 150 });
  void inBackground(async () => prewarmQuiz());
  await pause(10);
  const t = Date.now();
  await assert.rejects(getQuiz(), /The quiz is still being prepared in the background; try again in a minute/);
  assert.ok(Date.now() - t < 450, `answered after ${Date.now() - t} ms`);
  // A background caller joins the same build and waits for it, so it ends inside this test (the pool's own result
  // doesn't matter here; the fake AniList has no popular shows).
  await inBackground(() => getQuiz()).catch(() => undefined);
});
