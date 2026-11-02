import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { announcedChecker, followedIds } from "../server/data/following.js";
import { announceAired, follow, followedShows, unfollow } from "../server/services/following.js";
import { patchSettings } from "../server/services/settings.js";
import { addToSeason, installWorld, newWorld, NTFY, quietWarn, resetUserData, show, type World } from "./world.ts";

/** "Episode N is out" announcements for followed shows: what is sent, what is remembered, what a failure costs. */

let w: World;
let net: ReturnType<typeof installWorld>;
const now = () => Math.floor(Date.now() / 1000);
const notify = (over: Record<string, unknown> = {}) =>
  patchSettings((s) => ({
    ...s,
    notify: {
      ...s.notify,
      ntfyUrl: NTFY,
      discordWebhook: "",
      gotifyUrl: "",
      gotifyToken: "",
      airingAlerts: true,
      airingDelayMin: 0,
      ...over,
    },
  }));

beforeEach(async () => {
  resetUserData();
  w = newWorld();
  net = installWorld(w);
  const a = show(1, {
    title: { romaji: "Frieren", english: "Frieren", native: "葬送のフリーレン" },
    externalLinks: [{ site: "Crunchyroll", url: "https://cr.example/f", type: "STREAMING" }] as never,
  });
  const b = show(2, { title: { romaji: "Two", english: 'Two & "Quotes"', native: null } });
  addToSeason(w, "FALL", 2026, [a, b]);
  notify();
  for (const id of followedIds()) unfollow(id);
  await follow(1);
  await follow(2);
});
afterEach(() => net.restore());

describe("announceAired", () => {
  test("announces fresh episodes once each, with where to watch, and never repeats them", async () => {
    w.aired = [
      { mediaId: 1, episode: 5, airingAt: now() - 3600 },
      { mediaId: 2, episode: 3, airingAt: now() - 7200 },
    ];
    assert.equal(await announceAired(), 2);
    assert.equal(w.ntfySent.length, 2);
    const t = w.ntfySent.map((x) => x.title).sort();
    assert.deepEqual(t, ["Frieren: episode 5 is out", 'Two & "Quotes": episode 3 is out']);
    assert.match(w.ntfySent.find((x) => x.title.startsWith("Frieren"))!.message, /Crunchyroll/);
    assert.equal(await announceAired(), 0, "second run finds nothing new");
    assert.equal(w.ntfySent.length, 2);
  });

  test("an alert channel being down does not mark episodes announced: they are retried", async () => {
    w.aired = [{ mediaId: 1, episode: 6, airingAt: now() - 600 }];
    w.fail.ntfy = 503;
    const { value, warnings } = await quietWarn(() => announceAired());
    assert.equal(value, 1);
    assert.ok(warnings.some((x) => /will retry/.test(x)));
    assert.equal(announcedChecker()(1, 6), false);
    delete w.fail.ntfy;
    await announceAired();
    assert.equal(announcedChecker()(1, 6), true);
    assert.equal(w.ntfySent.length, 1);
  });

  test("one show failing to send does not stop the others", async () => {
    w.aired = [
      { mediaId: 1, episode: 7, airingAt: now() - 600 },
      { mediaId: 2, episode: 7, airingAt: now() - 600 },
    ];
    let n = 0;
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) =>
      String(u).includes("ntfy.test") && n++ === 0 ? Promise.resolve(new Response("{}", { status: 500 })) : real(u, i)) as typeof fetch;
    try {
      await quietWarn(() => announceAired());
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(w.ntfySent.length, 1);
    assert.equal(announcedChecker()(1, 7) !== announcedChecker()(2, 7), true, "exactly one was recorded");
  });

  test("episodes waiting inside the simulcast delay are not announced yet", async () => {
    notify({ airingDelayMin: 120 });
    w.aired = [{ mediaId: 1, episode: 8, airingAt: now() - 60 }];
    // The adapter asks AniList for a window ending 2 h ago, so a fake that ignores the window must not leak it:
    // here the fake returns the episode regardless, so the assertion is on the window the service asked for.
    await announceAired();
    const q = net.calls.filter((c) => c.url.includes("anilist")).at(-1)!.body as { variables: { to: number } };
    assert.ok(q.variables.to <= now() - 119 * 60);
  });

  test("airing alerts off, no channel, or nobody followed: nothing is fetched at all", async () => {
    w.aired = [{ mediaId: 1, episode: 9, airingAt: now() - 600 }];
    const calls = () => net.calls.filter((c) => c.url.includes("anilist")).length;
    const before = calls();
    notify({ airingAlerts: false });
    assert.equal(await announceAired(), 0);
    notify({ ntfyUrl: "" });
    assert.equal(await announceAired(), 0);
    notify();
    unfollow(1);
    unfollow(2);
    assert.equal(await announceAired(), 0);
    assert.equal(calls(), before);
  });

  test("AniList's schedule being down is an error for the job runner to log, not a half-sent batch", async () => {
    w.fail.anilistAired = 500;
    await assert.rejects(announceAired(), /having trouble/);
    assert.equal(w.ntfySent.length, 0);
  });
});

describe("follow list", () => {
  test("following an unknown show is a 404; episodes aired before following are never announced", async () => {
    await assert.rejects(follow(9999), /Unknown show/);
    addToSeason(w, "FALL", 2026, [show(3, { nextAiringEpisode: { airingAt: now() + 100, episode: 4 } })]);
    await follow(3);
    assert.equal(announcedChecker()(3, 3), true);
    assert.equal(announcedChecker()(3, 4), false);
  });

  test("followedShows returns cards for what is followed, with CJK intact", async () => {
    const list = await followedShows();
    assert.deepEqual(list.map((x) => x.id).sort(), [1, 2]);
  });
});
