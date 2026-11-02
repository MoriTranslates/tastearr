import "../env.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as radarr from "../../server/adapters/radarr.js";
import * as sonarr from "../../server/adapters/sonarr.js";
import { cjkSeries, movies, qualityProfiles, radarrStatus, rootFolders, sonarrStatus, tagList } from "../fixtures/arr.ts";
import { fakeServer, hang, reply, shortTimeouts, type Handler } from "./fake-server.ts";

/** Sonarr and Radarr share one client (adapters/arr.ts); each failure mode is checked through both public wrappers. */

let mode: Handler = () => undefined;
let srv: Awaited<ReturnType<typeof fakeServer>>;
let restoreTimeout: () => void;
before(async () => {
  srv = await fakeServer((req, res) => mode(req, res));
  restoreTimeout = shortTimeouts();
});
after(async () => {
  restoreTimeout();
  await srv.close();
});
const conn = () => ({ url: srv.url, apiKey: "test-key" });
const timedOut = (e: Error) => /abort|timeout/i.test(e.name + e.message);

describe("Sonarr", () => {
  test("happy path: status, key header, library with CJK titles intact", async () => {
    mode = (req, res) => {
      if (req.path === "/api/v3/system/status") return reply(res, 200, sonarrStatus);
      if (req.path === "/api/v3/series") return reply(res, 200, cjkSeries);
      reply(res, 404, {});
    };
    assert.deepEqual(await sonarr.status(conn()), { version: "4.0.9.2244" });
    const all = await sonarr.allSeries(conn());
    assert.equal(all[0].title, "葬送のフリーレン");
    assert.equal(all[2].title, "【推しの子】");
    assert.equal(srv.seen.at(-1)!.headers["x-api-key"], "test-key");
  });

  test("options: only id/name are kept; empty lists are fine", async () => {
    mode = (req, res) => {
      if (req.path.endsWith("/qualityprofile")) return reply(res, 200, qualityProfiles);
      if (req.path.endsWith("/rootfolder")) return reply(res, 200, rootFolders);
      reply(res, 200, req.path.endsWith("/tag") ? tagList : []);
    };
    const o = await sonarr.options(conn());
    assert.deepEqual(o.profiles[1], { id: 4, name: "HD-1080p" });
    assert.deepEqual(o.roots, [{ id: 1, path: "/tv" }]);
    mode = (_req, res) => reply(res, 200, []);
    assert.deepEqual(await sonarr.options(conn()), { profiles: [], roots: [], tags: [] });
    assert.deepEqual(await sonarr.allSeries(conn()), []);
  });

  test("401 and 404 name the app, the path (no query string) and the status", async () => {
    mode = (_req, res) => reply(res, 401, { error: "Unauthorized" });
    await assert.rejects(sonarr.allSeries(conn()), /Sonarr GET \/series failed \(HTTP 401\)/);
    mode = (_req, res) => reply(res, 404, "Not Found");
    await assert.rejects(sonarr.lookup(conn(), "tvdb:1"), (e: Error) => /HTTP 404/.test(e.message) && !e.message.includes("term="));
  });

  test("429 with Retry-After and 5xx are reported as errors, not retried silently", async () => {
    let hits = 0;
    mode = (_req, res) => (hits++, reply(res, 429, {}, { "Retry-After": "3" }));
    await assert.rejects(sonarr.allSeries(conn()), /HTTP 429/);
    assert.equal(hits, 1);
    mode = (_req, res) => reply(res, 503, "<html>maintenance</html>");
    await assert.rejects(sonarr.allSeries(conn()), /HTTP 503/);
  });

  test("a hung server fails by timeout instead of hanging forever", async () => {
    mode = hang;
    await assert.rejects(sonarr.allSeries(conn()), timedOut);
  });

  test("malformed JSON rejects; an empty body (204-style) resolves to undefined", async () => {
    mode = (_req, res) => reply(res, 200, "{not json");
    await assert.rejects(sonarr.allSeries(conn()), /Sonarr GET \/series answered with something that isn't JSON; check the address/);
    mode = (_req, res) => reply(res, 200, "");
    assert.equal(await sonarr.putSeries(conn(), 1, { id: 1 }), undefined);
  });

  test("posts UTF-8 JSON bodies unchanged (CJK, quotes, ampersands)", async () => {
    mode = (_req, res) => reply(res, 201, { id: 99 });
    const series = { title: '推しの子 "&" <b>', tvdbId: 1 };
    await sonarr.addSeries(conn(), series);
    assert.deepEqual(JSON.parse(srv.seen.at(-1)!.body), series);
  });

  test("pointing Sonarr's settings at Radarr is caught", async () => {
    mode = (_req, res) => reply(res, 200, radarrStatus);
    await assert.rejects(sonarr.status(conn()), /That's Radarr, not Sonarr/);
  });

  test("ensureTag reuses the tastearr tag or creates it", async () => {
    mode = (_req, res) => reply(res, 200, [{ id: 7, label: "tastearr" }]);
    assert.equal(await sonarr.ensureTag(conn()), 7);
    mode = (req, res) => (req.method === "POST" ? reply(res, 201, { id: 8 }) : reply(res, 200, []));
    assert.equal(await sonarr.ensureTag(conn()), 8);
    mode = (req, res) => (req.method === "POST" ? reply(res, 500, {}) : reply(res, 200, []));
    await assert.rejects(sonarr.ensureTag(conn()), /HTTP 500/);
  });

  test("unconfigured and refused addresses never reach the network", async () => {
    const before = srv.seen.length;
    await assert.rejects(sonarr.allSeries({ url: "", apiKey: "k" }), /not configured/);
    await assert.rejects(sonarr.allSeries({ url: srv.url, apiKey: "" }), /not configured/);
    await assert.rejects(sonarr.allSeries({ url: "http://169.254.169.254", apiKey: "k" }), /isn't allowed/);
    await assert.rejects(sonarr.allSeries({ url: "ftp://x", apiKey: "k" }), /http/);
    assert.equal(srv.seen.length, before);
  });
});

describe("Radarr", () => {
  test("happy path with a CJK movie title and lookup parameters", async () => {
    mode = (req, res) => {
      if (req.path === "/api/v3/movie") return reply(res, 200, movies);
      reply(res, 200, movies[0]);
    };
    assert.equal((await radarr.allMovies(conn()))[0].title, "君の名は。");
    await radarr.lookupTmdb(conn(), 372058);
    assert.equal(srv.seen.at(-1)!.path, "/api/v3/movie/lookup/tmdb?tmdbId=372058");
    await radarr.lookupImdb(conn(), "tt5311514");
    assert.equal(srv.seen.at(-1)!.path, "/api/v3/movie/lookup/imdb?imdbId=tt5311514");
  });

  test("failure modes: 401, 404, 429, 500, malformed, empty list", async () => {
    for (const code of [401, 404, 429, 500]) {
      mode = (_req, res) => reply(res, code, {}, code === 429 ? { "Retry-After": "1" } : {});
      await assert.rejects(radarr.allMovies(conn()), new RegExp(`Radarr GET /movie failed \\(HTTP ${code}\\)`));
    }
    mode = (_req, res) => reply(res, 200, "<html>");
    await assert.rejects(radarr.allMovies(conn()), /Radarr GET \/movie answered with something that isn't JSON/);
    mode = (_req, res) => reply(res, 200, []);
    assert.deepEqual(await radarr.allMovies(conn()), []);
  });

  test("status rejects a Sonarr address; timeout is enforced", async () => {
    mode = (_req, res) => reply(res, 200, sonarrStatus);
    await assert.rejects(radarr.status(conn()), /That's Sonarr, not Radarr/);
    mode = hang;
    await assert.rejects(radarr.addMovie(conn(), { tmdbId: 1 }), timedOut);
  });
});
