import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANILIST_LIMITS, fetchSeason, rateLimitWaitMs } from "../server/adapters/anilist.js";
import { MAL_LIMITS } from "../server/adapters/mal.js";
import { seasonOf, shiftSeason } from "../server/core/taste/media.js";
import { db } from "../server/data/db.js";
import { listJobs, noteJobError, setJob } from "../server/data/jobs.js";
import { setValue } from "../server/data/kv.js";
import { listEntries, replaceListEntries } from "../server/data/lists.js";
import { refresh } from "../server/services/jobs.js";
import { refreshLists, refreshListsDetailed } from "../server/services/lists.js";
import { buildProfile, getProfile, storedProfile } from "../server/services/profile.js";
import { getSettings, patchSettings } from "../server/services/settings.js";
import { emptyCtx, json, media, mockFetch, type Call } from "./helpers.ts";

/** AniList / MAL failures: retried with the server's own wait times, and never allowed to sink a whole build. */

Object.assign(ANILIST_LIMITS, { gapMs: 0, retries: 3, backoffMs: 1, maxWaitMs: 5_000 });
Object.assign(MAL_LIMITS, { retries: 1, backoffMs: 1 });

const quiet = async <T>(fn: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};
const vars = (c: Call) => (c.body as { variables: Record<string, unknown> }).variables;
const page = (list: unknown[]) => json({ data: { Page: { pageInfo: { hasNextPage: false }, media: list } } });
const job = (name: string) => listJobs().find((j) => j.name === name);
const isAniList = (u: URL) => u.hostname === "graphql.anilist.co";
/** Nothing cached: every season has to come from AniList. */
const forgetAniListCache = () => db.exec("DELETE FROM season_fetch; DELETE FROM media;");

test("rate-limit headers: Retry-After in seconds or as a date, else X-RateLimit-Reset", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(rateLimitWaitMs(new Headers({ "retry-after": "7" }), now), 7000);
  assert.equal(rateLimitWaitMs(new Headers({ "retry-after": "Tue, 01 Jan 2030 00:00:30 GMT" }), now), 30_000);
  assert.equal(rateLimitWaitMs(new Headers({ "x-ratelimit-reset": String(now / 1000 + 12) }), now), 12_000);
  assert.equal(rateLimitWaitMs(new Headers({}), now), null);
});

test("a 429 waits for Retry-After and then succeeds", async () => {
  let n = 0;
  const m = mockFetch((u) => {
    if (!isAniList(u)) return undefined;
    if (n++ === 0) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    return page([media(1)]);
  });
  try {
    const t = Date.now();
    const got = await fetchSeason("WINTER", 2030);
    assert.ok(Date.now() - t >= 900, "waited for Retry-After");
    assert.deepEqual(
      got.map((x) => x.id),
      [1],
    );
    assert.equal(m.calls.length, 2);
  } finally {
    m.restore();
  }
});

test("a 429 asking for longer than maxWaitMs fails at once with the wait in the message, instead of hanging", async () => {
  const m = mockFetch((u) => (isAniList(u) ? new Response("", { status: 429, headers: { "retry-after": "3600" } }) : undefined));
  try {
    const t = Date.now();
    await assert.rejects(fetchSeason("WINTER", 2030), /rate limit.*3600 seconds/);
    assert.ok(Date.now() - t < 2000);
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test("network errors and 5xx are retried with backoff; when they persist the error is clear", async () => {
  let n = 0;
  const m = mockFetch((u) => {
    if (!isAniList(u)) return undefined;
    n++;
    if (n === 1) throw new TypeError("fetch failed");
    if (n === 2) return new Response("bad gateway", { status: 502 });
    return page([media(2)]);
  });
  try {
    assert.deepEqual(
      (await fetchSeason("WINTER", 2030)).map((x) => x.id),
      [2],
    );
  } finally {
    m.restore();
  }
  const down = mockFetch((u) => (isAniList(u) ? new Response("", { status: 503 }) : undefined));
  try {
    await assert.rejects(fetchSeason("WINTER", 2030), /AniList is having trouble/);
    assert.equal(down.calls.length, ANILIST_LIMITS.retries + 1);
  } finally {
    down.restore();
  }
});

test("an answer that isn't JSON, or has no data, gives a clear error rather than a TypeError", async () => {
  let m = mockFetch((u) => (isAniList(u) ? new Response("<html>oops</html>", { status: 200 }) : undefined));
  try {
    await assert.rejects(fetchSeason("WINTER", 2030), /isn't valid JSON/);
  } finally {
    m.restore();
  }
  m = mockFetch((u) => (isAniList(u) ? json({ data: null }) : undefined));
  try {
    await assert.rejects(fetchSeason("WINTER", 2030), /empty answer/);
  } finally {
    m.restore();
  }
});

// --- Profile build

const end = seasonOf();
const s1 = shiftSeason(end, -1);
const s2 = shiftSeason(end, -2);
const seasonShows = (season: { season: string; year: number }, base: number) =>
  [0, 1, 2].map((i) => media(base + i, { season: season.season as never, seasonYear: season.year }));

test("profile build: one season AniList can't send is skipped, the build finishes and the job keeps the problem", async () => {
  patchSettings((s) => ({ ...s, training: { ...s.training, seasons: 2 } }));
  const m = mockFetch((u, c) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    if (!isAniList(u)) return undefined;
    const v = vars(c);
    if (v.season === s1.season && v.year === s1.year) return new Response("", { status: 500 });
    if (v.season === s2.season && v.year === s2.year) return page(seasonShows(s2, 200));
    return page([]);
  });
  try {
    const p = await quiet(() => buildProfile());
    assert.equal(p.trainedOn, 3, "the season that worked");
    const j = job("profile")!;
    assert.equal(j.state, "done");
    assert.match(j.detail, /1 problem/);
    assert.match(j.lastError ?? "", new RegExp(`${s1.season.toLowerCase()} ${s1.year} skipped`));
    assert.ok(j.lastSuccessAt);
  } finally {
    m.restore();
  }
});

test("profile build: a season with a cached copy uses it when AniList is down", async () => {
  // s2 was cached by the previous test; force a refetch by asking for a stale copy and failing it.
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    return isAniList(u) ? new Response("", { status: 503 }) : undefined;
  });
  try {
    const p = await quiet(() => buildProfile({ save: false, ctx: emptyCtx() }));
    assert.equal(p.trainedOn, 3, "s2 from cache (still fresh), s1 skipped");
  } finally {
    m.restore();
  }
});

test("profile build: when no season can be read the job is an error, and the last success is kept", async () => {
  const before = job("profile")!.lastSuccessAt;
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    return isAniList(u) ? new Response("", { status: 503 }) : undefined;
  });
  // Move the training window so nothing is cached.
  try {
    await assert.rejects(
      quiet(() => buildProfile({ until: shiftSeason(end, -20) })),
      /Couldn't read any season/,
    );
    const j = job("profile")!;
    assert.equal(j.state, "error");
    assert.equal(j.lastSuccessAt, before, "failure didn't erase the last success");
    assert.match(j.lastError ?? "", /Couldn't read any season/);
  } finally {
    m.restore();
  }
});

test("getProfile: a failed rebuild falls back to the last good profile and doesn't retry AniList straight away", async () => {
  const old = { ...storedProfile()!, builtAt: Date.now() - 3 * 86_400_000 };
  setValue("profile", JSON.stringify(old));
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    return isAniList(u) ? new Response("", { status: 503 }) : undefined;
  });
  try {
    forgetAniListCache();
    const p1 = await quiet(() => getProfile());
    assert.equal(p1.builtAt, old.builtAt);
    const calls = m.calls.length;
    const p2 = await quiet(() => getProfile());
    assert.equal(p2.builtAt, old.builtAt);
    assert.equal(m.calls.length, calls, "no second rebuild within PROFILE_RETRY_MS");
  } finally {
    m.restore();
  }
});

test("profile build reads one settings snapshot: a change saved mid-build doesn't apply to half of it", async () => {
  const until = shiftSeason(end, -40);
  const a = shiftSeason(until, -1);
  const b = shiftSeason(until, -2);
  let changed = false;
  const m = mockFetch((u, c) => {
    if (!isAniList(u)) return undefined;
    const v = vars(c);
    if (!changed) {
      changed = true;
      // The user saves new training settings while the first season downloads.
      patchSettings((s) => ({ ...s, training: { ...s.training, formats: ["MOVIE"], seasons: 24 } }));
    }
    if (v.season === a.season && v.year === a.year) return page(seasonShows(a, 300));
    if (v.season === b.season && v.year === b.year) return page(seasonShows(b, 400));
    return page([]);
  });
  try {
    const p = await buildProfile({ until, save: false, ctx: emptyCtx() });
    assert.equal(p.trainedOn, 6, "both seasons filtered with the settings the build started with");
    assert.equal(m.calls.length, 2, "the season count it started with");
  } finally {
    patchSettings((s) => ({ ...s, training: { ...s.training, formats: ["TV", "TV_SHORT", "ONA"], seasons: 2 } }));
    m.restore();
  }
});

// --- List imports

test("lists: MAL rejecting the client ID (401) keeps the last MAL import and still imports AniList", async () => {
  replaceListEntries("mal", [{ id: 77, status: "COMPLETED", score: 80, progress: 12 }]);
  patchSettings((s) => ({ ...s, lists: { ...s.lists, anilistUser: "me", malUser: "me", malClientId: "bad" } }));
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    if (u.hostname === "api.myanimelist.net") return new Response("", { status: 401 });
    if (isAniList(u))
      return json({ data: { MediaListCollection: { lists: [{ entries: [{ mediaId: 5, status: "CURRENT", score: 0, progress: 3 }] }] } } });
    return undefined;
  });
  try {
    const r = await refreshListsDetailed();
    assert.deepEqual(r.imported, ["1 AniList entries"]);
    assert.match(r.errors[0], /MAL: MyAnimeList rejected the client ID \(HTTP 401\)/);
    const rows = listEntries();
    assert.ok(rows.some((e) => e.source === "anilist" && e.id === 5));
    assert.ok(
      rows.some((e) => e.source === "mal" && e.id === 77),
      "old MAL entries kept",
    );
    // The import button still reports the failure, after importing what it could.
    await assert.rejects(refreshLists(), /MAL: .*imported 1 AniList entries/);
  } finally {
    m.restore();
  }
});

test("lists: MAL sending garbage, or AniList saying the user doesn't exist, never wipes the stored entries", async () => {
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    if (u.hostname === "api.myanimelist.net") return new Response("<html>maintenance</html>", { status: 200 });
    if (isAniList(u)) return json({ data: { MediaListCollection: null } });
    return undefined;
  });
  try {
    const r = await refreshListsDetailed();
    assert.equal(r.imported.length, 0);
    assert.match(r.errors.join(" "), /not found or their list is private/);
    assert.match(r.errors.join(" "), /isn't valid JSON/);
    const rows = listEntries();
    assert.ok(rows.some((e) => e.source === "anilist" && e.id === 5));
    assert.ok(rows.some((e) => e.source === "mal" && e.id === 77));
  } finally {
    patchSettings((s) => ({ ...s, lists: { ...s.lists, anilistUser: "", malUser: "", malClientId: "" } }));
    m.restore();
  }
});

// --- Job history

test("job history: success after a failure keeps the failure; noteJobError doesn't change the state", () => {
  setJob("t-hist", "running", "go");
  setJob("t-hist", "error", "boom");
  const failedAt = job("t-hist")!.lastErrorAt;
  setJob("t-hist", "running", "again");
  setJob("t-hist", "done", "fine");
  let j = job("t-hist")!;
  assert.equal(j.state, "done");
  assert.equal(j.lastError, "boom");
  assert.equal(j.lastErrorAt, failedAt);
  assert.ok(j.lastSuccessAt);
  noteJobError("t-hist", "half a problem");
  j = job("t-hist")!;
  assert.equal(j.state, "done");
  assert.equal(j.lastError, "half a problem");
});

test("refresh job: a failing step doesn't stop the later ones, and the error names each failed step", async () => {
  patchSettings((s) => ({
    ...s,
    auth: { ...s.auth, passwordHash: s.auth.passwordHash || "x" },
    autoAdd: { ...s.autoAdd, enabled: false },
    notify: { ...s.notify, seasonAlerts: false },
  }));
  setValue("profile", "");
  forgetAniListCache();
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    return isAniList(u) ? new Response("", { status: 503 }) : undefined;
  });
  const warnings: string[] = [];
  try {
    await quiet(() => refresh((w) => warnings.push(w)));
    const j = job("refresh")!;
    assert.equal(j.state, "error");
    assert.match(j.detail, /taste profile: /);
    assert.match(j.detail, /picks: /, "picks still ran after the profile failed");
    assert.equal(warnings.length, 1);
    assert.ok(getSettings().auth.passwordHash);
  } finally {
    m.restore();
  }
});
