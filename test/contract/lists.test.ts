import "../env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  ANILIST_LIMITS,
  airedBetween,
  anilistUserList,
  fetchByIds,
  fetchSeason,
  popularIdsBatch,
  searchTitle,
} from "../../server/adapters/anilist.js";
import { animeListAge, downloadAnimeList, readAnimeList } from "../../server/adapters/animelists.js";
import { malUserList } from "../../server/adapters/mal.js";
import { cjkMedia, malPage1, malPage2, page, userList } from "../fixtures/anilist.ts";
import { json, mockFetch } from "../helpers.ts";
import { media } from "../helpers.ts";
import { shortTimeouts } from "./fake-server.ts";

/** AniList, MyAnimeList and the anime-list download have fixed hosts, so these use the fetch mock (no local server). */

// AniList's adapter waits between calls (rate limit, Retry-After). Run those waits instantly and record what was asked.
const realSetTimeout = globalThis.setTimeout;
let waits: number[] = [];
beforeEach(() => {
  waits = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) => {
    if ((ms ?? 0) >= 300) {
      waits.push(ms!);
      return realSetTimeout(fn, 0, ...a);
    }
    return realSetTimeout(fn, ms, ...a);
  }) as typeof setTimeout;
});
afterEach(() => void (globalThis.setTimeout = realSetTimeout));

const hdr = (h: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  "x-ratelimit-limit": "90",
  "x-ratelimit-remaining": "80",
  ...h,
});
const reply = (body: unknown, status = 200, h: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: hdr(h) });

describe("AniList", () => {
  test("happy path: season pages are merged, de-duplicated and CJK titles kept", async () => {
    let n = 0;
    const m = mockFetch(() => reply(page(n++ === 0 ? [cjkMedia, media(2)] : [media(2), media(3)], n === 1)));
    try {
      const list = await fetchSeason("WINTER", 2030);
      assert.deepEqual(
        list.map((x) => x.id),
        [154587, 2, 3],
      );
      assert.equal(list[0].title.native, "葬送のフリーレン");
      assert.equal(m.calls.length, 2);
      const v = (m.calls[0].body as { variables: unknown }).variables;
      assert.deepEqual(v, { page: 1, season: "WINTER", year: 2030 });
    } finally {
      m.restore();
    }
  });

  test("an empty season, empty id list and empty search are empty arrays, not errors", async () => {
    const m = mockFetch(() => reply(page([])));
    try {
      assert.deepEqual(await fetchSeason("FALL", 2031), []);
      assert.deepEqual(await fetchByIds([]), []);
      assert.deepEqual(await searchTitle("zzzz"), []);
    } finally {
      m.restore();
    }
  });

  test("pagination stops at 10 pages even if AniList keeps saying there is more", async () => {
    const m = mockFetch(() => reply(page([], true)));
    try {
      await fetchSeason("SPRING", 2031);
      assert.equal(m.calls.length, 10);
    } finally {
      m.restore();
    }
  });

  test("429 honours Retry-After then succeeds", async () => {
    let n = 0;
    const m = mockFetch(() => (n++ === 0 ? reply({}, 429, { "retry-after": "7" }) : reply(page([media(9)]))));
    try {
      assert.equal((await searchTitle("x")).length, 1);
      assert.equal(m.calls.length, 2);
      assert.ok(waits.includes(7000), `waited ${waits}`);
    } finally {
      m.restore();
    }
  });

  test("429 forever gives up with a readable error instead of looping", async () => {
    const m = mockFetch(() => reply("slow down", 429, { "retry-after": "1" }));
    try {
      await assert.rejects(searchTitle("x"), /AniList's rate limit was hit; try again in 1 seconds/);
      assert.equal(m.calls.length, ANILIST_LIMITS.retries + 1);
    } finally {
      m.restore();
    }
  });

  test("a Retry-After longer than the longest wait fails at once with when to try again", async () => {
    const m = mockFetch(() => reply("slow down", 429, { "retry-after": "600" }));
    try {
      await assert.rejects(searchTitle("x"), /rate limit was hit; try again in 600 seconds/);
      assert.equal(m.calls.length, 1);
      assert.ok(!waits.includes(600_000), `waited ${waits}`);
    } finally {
      m.restore();
    }
  });

  test("5xx says AniList is having trouble; 401/404 include the (HTML-stripped) body", async () => {
    let m = mockFetch(() => reply("<html>bad gateway</html>", 502));
    try {
      await assert.rejects(searchTitle("x"), /having trouble.*HTTP 502/);
    } finally {
      m.restore();
    }
    for (const code of [401, 404]) {
      m = mockFetch(() => reply("<h1>Nope</h1>", code));
      try {
        await assert.rejects(
          searchTitle("x"),
          (e: Error) => e.message.includes(`HTTP ${code}`) && e.message.includes("Nope") && !e.message.includes("<h1>"),
        );
      } finally {
        m.restore();
      }
    }
  });

  test("GraphQL errors and malformed JSON reject; one bad call does not poison the queue", async () => {
    let step = 0;
    const m = mockFetch(() => {
      step++;
      if (step === 1) return reply({ errors: [{ message: "Too Many Requests" }], data: null });
      if (step === 2) return reply("{oops");
      return reply(page([media(5)]));
    });
    try {
      await assert.rejects(searchTitle("a"), /AniList: Too Many Requests/);
      await assert.rejects(searchTitle("b"), (e: Error) => /isn't valid JSON/.test(e.message) && e.cause instanceof SyntaxError);
      assert.equal((await searchTitle("c"))[0].id, 5);
    } finally {
      m.restore();
    }
  });

  test("a hung connection times out", async () => {
    const restore = shortTimeouts(50);
    const prev = globalThis.fetch;
    globalThis.fetch = ((_u: unknown, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as typeof fetch;
    try {
      await assert.rejects(searchTitle("x"), (e: Error) => /abort|timeout/i.test(e.name + e.message));
    } finally {
      globalThis.fetch = prev;
      restore();
    }
  });

  test("user list: all lists flattened; a private or missing user surfaces AniList's message", async () => {
    let m = mockFetch(() => reply(userList));
    try {
      assert.deepEqual(
        (await anilistUserList("adam")).map((e) => e.mediaId),
        [1, 2],
      );
    } finally {
      m.restore();
    }
    m = mockFetch(() => reply({ errors: [{ message: "User not found" }], data: { MediaListCollection: null } }, 404));
    try {
      await assert.rejects(anilistUserList("nobody"), /HTTP 404/);
    } finally {
      m.restore();
    }
    m = mockFetch(() => reply({ data: { MediaListCollection: { lists: [] } } }));
    try {
      assert.deepEqual(await anilistUserList("empty"), []);
    } finally {
      m.restore();
    }
  });

  test("airedBetween batches ids by 50 and follows pages; empty id list makes no call", async () => {
    const m = mockFetch((_u, c) => {
      const v = (c.body as { variables: { ids: number[]; page: number } }).variables;
      const sched = [{ mediaId: v.ids[0], episode: 1, airingAt: 100 + v.page }];
      return reply({ data: { Page: { pageInfo: { hasNextPage: v.page === 1 }, airingSchedules: sched } } });
    });
    try {
      assert.deepEqual(await airedBetween([], 0, 1), []);
      assert.equal(m.calls.length, 0);
      const out = await airedBetween(
        Array.from({ length: 60 }, (_, i) => i + 1),
        0,
        1000,
      );
      assert.equal(m.calls.length, 4); // 2 chunks x 2 pages
      assert.equal(out.length, 4);
    } finally {
      m.restore();
    }
  });

  test("popularIdsBatch: chunks of 8, first-season flag from PREQUEL/PARENT anime relations, missing pages tolerated", async () => {
    const m = mockFetch((_u, c) => {
      const q = (c.body as { query: string }).query;
      const n = (q.match(/p\d+: Page/g) ?? []).length;
      const data: Record<string, unknown> = {};
      for (let k = 0; k < n; k++) {
        if (k === 1) continue; // AniList left one alias out
        data[`p${k}`] = {
          media: [
            { id: k * 10 + 1, startDate: { year: 2020 }, relations: { edges: [{ relationType: "PREQUEL", node: { type: "ANIME" } }] } },
            { id: k * 10 + 2, startDate: null, relations: { edges: [{ relationType: "PREQUEL", node: { type: "MANGA" } }] } },
            { id: k * 10 + 3, startDate: { year: 2021 }, relations: null },
          ],
        };
      }
      return reply({ data });
    });
    try {
      const out = await popularIdsBatch(Array.from({ length: 10 }, () => ({ genre_in: ["Fantasy"] })));
      assert.equal(m.calls.length, 2);
      assert.equal(out.length, 10);
      assert.deepEqual(
        out[0].map((x) => x.firstSeason),
        [false, true, true],
      );
      assert.equal(out[0][1].year, null);
      assert.deepEqual(out[1], []);
    } finally {
      m.restore();
    }
  });

  test("a reply without X-RateLimit headers does not stall the next call for a minute", async () => {
    const m = mockFetch(() => new Response(JSON.stringify(page([media(1)])), { status: 200 }));
    try {
      await searchTitle("a");
      await searchTitle("b");
      assert.equal(m.calls.length, 2);
      assert.ok(
        waits.every((ms) => ms < 10_000),
        `waited ${waits}`,
      );
    } finally {
      m.restore();
    }
  });
});

describe("MyAnimeList", () => {
  test("follows paging, sends the client id header, keeps CJK-titled entries", async () => {
    const m = mockFetch((u) => json(u.searchParams.get("offset") ? malPage2 : malPage1));
    try {
      const list = await malUserList("adam", "cid");
      assert.deepEqual(list, [
        { malId: 52991, status: "completed", score: 10, episodesWatched: 28 },
        { malId: 5114, status: "dropped", score: 0, episodesWatched: 2 },
      ]);
      assert.equal(m.calls[0].headers["x-mal-client-id"], "cid");
    } finally {
      m.restore();
    }
  });

  test("user names with odd characters are encoded; empty list is empty", async () => {
    const m = mockFetch(() => json({ data: [] }));
    try {
      assert.deepEqual(await malUserList("a b/ü", "cid"), []);
      assert.match(m.calls[0].url, /users\/a%20b%2F%C3%BC\/animelist/);
    } finally {
      m.restore();
    }
  });

  test("404 means not found or private; 401, 429 and 5xx are plain failures", async () => {
    const m404 = mockFetch(() => json({}, 404));
    try {
      await assert.rejects(malUserList("ghost", "c"), /not found or list is private/);
    } finally {
      m404.restore();
    }
    for (const code of [401, 429, 500]) {
      const m = mockFetch(() => new Response("{}", { status: code, headers: { "Retry-After": "9" } }));
      try {
        await assert.rejects(malUserList("u", "c"), new RegExp(`HTTP ${code}`));
      } finally {
        m.restore();
      }
    }
  });

  test("malformed JSON rejects and a paging loop is capped at 20 pages", async () => {
    let m = mockFetch(() => new Response("<html>", { status: 200 }));
    try {
      await assert.rejects(
        malUserList("u", "c"),
        (e: Error) => /MyAnimeList sent an answer that isn't valid JSON/.test(e.message) && e.cause instanceof SyntaxError,
      );
    } finally {
      m.restore();
    }
    m = mockFetch(() => json({ data: [], paging: { next: "https://api.myanimelist.net/v2/loop" } }));
    try {
      await malUserList("u", "c");
      assert.equal(m.calls.length, 20);
    } finally {
      m.restore();
    }
  });
});

describe("anime-list download", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-"));
  const file = path.join(dir, "list.json");

  test("writes via a temp file; a failed download leaves the old copy untouched and no .tmp behind", async () => {
    let m = mockFetch(() => json([{ anilist_id: 1, tvdb_id: 2, notes: "葬送" }]));
    try {
      await downloadAnimeList(file);
    } finally {
      m.restore();
    }
    assert.equal(readAnimeList(file)[0].anilist_id, 1);
    assert.ok((animeListAge(file) ?? Infinity) < 5000);
    for (const status of [404, 429, 500]) {
      m = mockFetch(() => new Response("nope", { status }));
      try {
        await assert.rejects(downloadAnimeList(file), new RegExp(`HTTP ${status}`));
      } finally {
        m.restore();
      }
    }
    assert.equal(readAnimeList(file).length, 1);
    assert.equal(fs.existsSync(file + ".tmp"), false);
    assert.equal(animeListAge(path.join(dir, "missing.json")), null);
  });

  test("a truncated download (connection cut mid-body) does not replace a good file", async () => {
    const m = mockFetch(() => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("[{"));
          c.error(new Error("socket hang up"));
        },
      });
      return new Response(body, { status: 200 });
    });
    try {
      await assert.rejects(downloadAnimeList(file));
    } finally {
      m.restore();
    }
    assert.equal(readAnimeList(file).length, 1);
  });

  test("a download that completes but is not a JSON list (an HTML page with HTTP 200, an object) never replaces the good list", async () => {
    for (const [body, why] of [
      ["<!doctype html><html><body>Sign in to the Wi-Fi</body></html>".repeat(50), /isn't valid JSON/],
      [JSON.stringify({ message: "rate limited" }).padEnd(4000), /isn't a list/],
    ] as const) {
      const m = mockFetch(() => new Response(body, { status: 200 }));
      try {
        await assert.rejects(downloadAnimeList(file), why);
      } finally {
        m.restore();
      }
      assert.equal(readAnimeList(file).length, 1);
    }
  });
});
