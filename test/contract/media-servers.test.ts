import "../env.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { jellyfinInfo, jellyfinLibraries, jellyfinUsers, jellyfinWatchStates } from "../../server/adapters/jellyfin.js";
import { plexCheckPin, plexCreatePin, plexInfo, plexLibraries, plexServers, plexWatchStates } from "../../server/adapters/plex.js";
import type { ShowIdTables } from "../../server/adapters/showids.js";
import {
  jfInfo,
  jfSeasons,
  jfSeries,
  jfUsers,
  jfViews,
  plexResources,
  plexRoot,
  plexSeasons,
  plexSections,
  plexShows,
} from "../fixtures/media-servers.ts";
import { json, mockFetch } from "../helpers.ts";
import { fakeServer, hang, reply, shortTimeouts, type Handler } from "./fake-server.ts";

let mode: Handler = () => undefined;
let srv: Awaited<ReturnType<typeof fakeServer>>;
let restore: () => void;
before(async () => {
  srv = await fakeServer((req, res) => mode(req, res));
  restore = shortTimeouts();
});
after(async () => {
  restore();
  await srv.close();
});
const plex = () => ({ url: srv.url, token: "pt" });
/** Mapping-list lookups for shows a media server filed without a TVDB id; empty unless a test fills a column. */
const tables = (t: Partial<ShowIdTables> = {}): ShowIdTables => ({
  anidb: new Map(),
  tmdb: new Map(),
  imdb: new Map(),
  anilist: new Map(),
  ...t,
});
const jf = () => ({ url: srv.url, token: "jt", userId: "u1" });

/** 401/404/429/5xx name the status, malformed JSON rejects, a hung server times out. */
async function failureModes(call: () => Promise<unknown>, label: string) {
  for (const code of [401, 404, 429, 500, 502]) {
    mode = (_req, res) => reply(res, code, {}, code === 429 ? { "Retry-After": "5" } : {});
    await assert.rejects(call(), new RegExp(`${label}.*HTTP ${code}`));
  }
  mode = (_req, res) => reply(res, 200, "<<<not json");
  await assert.rejects(call(), SyntaxError);
  mode = hang;
  await assert.rejects(call(), (e: Error) => /abort|timeout/i.test(e.name + e.message));
}

describe("Plex", () => {
  test("info and show libraries only (movie libraries and CJK names handled)", async () => {
    mode = (req, res) => reply(res, 200, req.path === "/" ? plexRoot : plexSections);
    assert.deepEqual(await plexInfo(plex()), { name: "Living Room", version: "1.41.3.9314-a0bfb8370" });
    assert.deepEqual(await plexLibraries(plex()), [
      { id: "2", title: "アニメ" },
      { id: "3", title: "TV Shows" },
    ]);
    assert.equal(srv.seen.at(-1)!.headers["x-plex-token"], "pt");
  });

  test("watch states: new agent, legacy agent, HAMA, and shows with no id; seasons only with progress", async () => {
    mode = (req, res) => reply(res, 200, req.path.includes("/children") ? plexSeasons : plexShows);
    const m = await plexWatchStates(plex(), ["2"], tables({ anidb: new Map([[4521, 5555]]) }));
    assert.deepEqual(
      [...m.keys()].sort((a, b) => a - b),
      [81797, 5555, 424536].sort((a, b) => a - b),
    );
    const f = m.get(424536)!;
    assert.equal(f.title, "葬送のフリーレン");
    assert.equal(f.watched, 12);
    assert.equal(f.rating, 9);
    assert.deepEqual(f.seasons.get(1), { watched: 12, total: 28 });
    assert.equal(m.get(81797)!.seasons.size, 0, "no progress means no per-season request");
    assert.equal(m.get(5555)!.watched, 13);
  });

  test("an unknown HAMA id is skipped; an empty library is an empty map", async () => {
    mode = (_req, res) => reply(res, 200, plexShows);
    const m = await plexWatchStates(plex(), ["2"], tables());
    assert.equal(m.size, 2);
    mode = (_req, res) => reply(res, 200, { MediaContainer: {} });
    assert.equal((await plexWatchStates(plex(), ["2"], tables())).size, 0);
    assert.deepEqual(await plexLibraries(plex()), []);
  });

  test("one season request failing keeps the show, just without season detail", async () => {
    mode = (req, res) => (req.path.includes("/children") ? reply(res, 500, {}) : reply(res, 200, plexShows));
    const m = await plexWatchStates(plex(), ["2"], tables());
    assert.equal(m.get(424536)!.watched, 12);
    assert.equal(m.get(424536)!.seasons.size, 0);
  });

  test("failure modes: 401 404 429 5xx malformed timeout", () => failureModes(() => plexInfo(plex()), "Plex"));

  test("a metadata address is refused before any request", async () => {
    await assert.rejects(plexInfo({ url: "http://169.254.169.254", token: "x" }), /isn't allowed/);
  });

  test("plex.tv: pin, check, servers (LAN http first, relays dropped, players dropped)", async () => {
    const m = mockFetch((u) => {
      if (u.pathname === "/api/v2/pins") return json({ id: 42, code: "ABCD" });
      if (u.pathname === "/api/v2/pins/42") return json({ authToken: "tok" });
      if (u.pathname === "/api/v2/resources") return json(plexResources);
    });
    try {
      const pin = await plexCreatePin("client-1");
      assert.equal(pin.id, 42);
      assert.match(pin.authUrl, /code=ABCD/);
      assert.equal(await plexCheckPin("client-1", 42), "tok");
      const servers = await plexServers("client-1", "acct");
      assert.equal(servers.length, 1);
      assert.deepEqual(servers[0].urls, ["http://192.168.1.5:32400", "https://192-168-1-5.hash.plex.direct:32400"]);
    } finally {
      m.restore();
    }
  });

  test("plex.tv errors surface their status", async () => {
    for (const code of [401, 429, 500]) {
      const m = mockFetch(() => json({}, code));
      try {
        await assert.rejects(plexCreatePin("c"), new RegExp(`plex.tv ${code}`));
        await assert.rejects(plexCheckPin("c", 1), new RegExp(`plex.tv ${code}`));
        await assert.rejects(plexServers("c", "t"), new RegExp(`plex.tv ${code}`));
      } finally {
        m.restore();
      }
    }
  });
});

describe("Jellyfin", () => {
  test("info, users, TV libraries only", async () => {
    mode = (req, res) => reply(res, 200, req.path === "/System/Info" ? jfInfo : req.path === "/Users" ? jfUsers : jfViews);
    assert.deepEqual(await jellyfinInfo(jf()), { name: "Media Box", version: "10.10.3" });
    assert.deepEqual(await jellyfinUsers(jf()), [
      { id: "u1", name: "adam" },
      { id: "u2", name: "ゲスト" },
    ]);
    assert.deepEqual(await jellyfinLibraries(jf()), [{ id: "v1", title: "Anime" }]);
    assert.equal(srv.seen.at(-1)!.headers["x-emby-token"], "jt");
  });

  test("watch states: favourite counts as 10, unwatched has no season request, specials without index skipped", async () => {
    mode = (req, res) => reply(res, 200, req.path.startsWith("/Shows/") ? jfSeasons : jfSeries);
    const m = await jellyfinWatchStates(jf(), ["v1"], tables());
    assert.deepEqual(
      [...m.keys()].sort((a, b) => a - b),
      [999, 424536],
    );
    const f = m.get(424536)!;
    assert.equal(f.title, "葬送のフリーレン");
    assert.equal(f.watched, 12);
    assert.equal(f.rating, 10);
    assert.deepEqual([...f.seasons], [[1, { watched: 12, total: 28 }]]);
    assert.equal(m.get(999)!.rating, 7);
    assert.equal(m.get(999)!.seasons.size, 0);
  });

  test("a show with only an IMDb id is mapped through the mapping list instead of dropped", async () => {
    mode = (req, res) => reply(res, 200, req.path.startsWith("/Shows/") ? { Items: [] } : jfSeries);
    const m = await jellyfinWatchStates(jf(), ["v1"], tables({ imdb: new Map([["tt1", 777]]) }));
    assert.equal(m.get(777)!.title, "No tvdb");
  });

  test("empty libraries and no user selected", async () => {
    mode = (_req, res) => reply(res, 200, { Items: [] });
    assert.equal((await jellyfinWatchStates(jf(), ["v1"], tables())).size, 0);
    assert.deepEqual(await jellyfinLibraries(jf()), []);
    await assert.rejects(jellyfinWatchStates({ ...jf(), userId: "" }, ["v1"], tables()), /Pick a Jellyfin user/);
    await assert.rejects(jellyfinLibraries({ ...jf(), userId: "" }), /Pick a Jellyfin user/);
  });

  test("a user id with odd characters is URL-encoded", async () => {
    mode = (_req, res) => reply(res, 200, { Items: [] });
    await jellyfinWatchStates({ ...jf(), userId: "a/b c" }, ["x&y"], tables());
    assert.match(srv.seen.at(-1)!.path, /^\/Users\/a%2Fb%20c\/Items\?ParentId=x%26y/);
  });

  test("failure modes: 401 404 429 5xx malformed timeout", () => failureModes(() => jellyfinInfo(jf()), "Jellyfin"));
});
