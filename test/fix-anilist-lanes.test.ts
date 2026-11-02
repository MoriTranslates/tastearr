import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ANILIST_LIMITS, fetchByIds, inBackground, searchTitle } from "../server/adapters/anilist.js";
import { json, media, mockFetch, type Call } from "./helpers.ts";

/**
 * Review 2026-11-02, item 5: one AniList queue made a page the user is waiting for sit behind minutes of background
 * work. Interactive calls now go first and fail fast on a long rate-limit pause; Retry-After is still honoured.
 */

const defaults = { ...ANILIST_LIMITS };
afterEach(() => void Object.assign(ANILIST_LIMITS, defaults));

const page = (list: unknown[]) => json({ data: { Page: { pageInfo: { hasNextPage: false }, media: list } } });
const vars = (c: Call) => (c.body as { variables: Record<string, unknown> }).variables;
const isAniList = (u: URL) => u.hostname === "graphql.anilist.co";

test("an interactive call goes ahead of queued background calls, and both keep the shared pace", async () => {
  Object.assign(ANILIST_LIMITS, { gapMs: 40 });
  const order: string[] = [];
  const m = mockFetch((u, c) => {
    if (!isAniList(u)) return undefined;
    const v = vars(c);
    order.push(v.q ? `search:${v.q}` : `ids:${(v.ids as number[])[0]}`);
    return page([media(1)]);
  });
  try {
    const background = inBackground(() => Promise.all([1, 2, 3, 4, 5].map((id) => fetchByIds([id]))));
    await new Promise((r) => setTimeout(r, 5)); // the background batch is queued first
    const t = Date.now();
    await searchTitle("frieren");
    const waited = Date.now() - t;
    await background;
    assert.deepEqual(order.slice(0, 2), ["ids:1", "search:frieren"], "only the call already started goes first");
    assert.ok(waited < 4 * 40, `the interactive call waited ${waited} ms, not behind all five`);
    assert.equal(order.length, 6);
  } finally {
    m.restore();
  }
});

test("during a long rate-limit pause from background work, an interactive call fails fast; the background call waits it out", async () => {
  Object.assign(ANILIST_LIMITS, { gapMs: 0, interactiveWaitMs: 200, maxWaitMs: 5_000 });
  let n = 0;
  const m = mockFetch((u) => {
    if (!isAniList(u)) return undefined;
    if (n++ === 0) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    return page([media(7)]);
  });
  try {
    const t = Date.now();
    const background = inBackground(() => fetchByIds([7]));
    await new Promise((r) => setTimeout(r, 50)); // the 429 has arrived and paused everyone
    await assert.rejects(searchTitle("frieren"), /rate limit was hit; try again in 1 seconds/);
    assert.ok(Date.now() - t < 500, "failed at once, not after the pause");
    assert.deepEqual(
      (await background).map((x) => x.id),
      [7],
    );
    assert.ok(Date.now() - t >= 900, "the background call honoured Retry-After");
    assert.equal(n, 2, "the interactive call never reached AniList");
  } finally {
    m.restore();
  }
});

test("a Retry-After far beyond maxWaitMs never stalls the scheduler: the pause is capped and later calls go through", async () => {
  Object.assign(ANILIST_LIMITS, { gapMs: 0, maxWaitMs: 200 });
  let n = 0;
  const m = mockFetch((u) => {
    if (!isAniList(u)) return undefined;
    if (n++ === 0) return new Response("", { status: 429, headers: { "retry-after": "3600" } });
    return page([media(9)]);
  });
  try {
    const t = Date.now();
    await assert.rejects(
      inBackground(() => fetchByIds([9])),
      /3600 seconds/,
    );
    assert.deepEqual(
      (await inBackground(() => fetchByIds([9]))).map((x) => x.id),
      [9],
    );
    assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
  } finally {
    m.restore();
  }
});

test("an interactive call stops retrying 5xx answers once the next backoff would pass its total deadline", async () => {
  Object.assign(ANILIST_LIMITS, { gapMs: 0, retries: 5, backoffMs: 300, interactiveTotalMs: 500 });
  let n = 0;
  const m = mockFetch((u) => {
    if (!isAniList(u)) return undefined;
    n++;
    return new Response("", { status: 503 });
  });
  try {
    const t = Date.now();
    await assert.rejects(searchTitle("x"), /AniList is having trouble/);
    assert.ok(Date.now() - t < 1500, `gave up after ${Date.now() - t} ms`);
    assert.ok(n < 6, `stopped early (${n} tries) instead of using every retry`);
  } finally {
    m.restore();
  }
});
