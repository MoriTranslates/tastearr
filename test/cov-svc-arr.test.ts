import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { addMovie, radarrMovies } from "../server/services/radarr.js";
import {
  checkPlexSignIn,
  choosePlexServer,
  listLibraries,
  startPlexSignIn,
  testMediaServer,
  watchStates,
} from "../server/services/mediaserver.js";
import { getSettings, patchSettings } from "../server/services/settings.js";
import { addSeries, forgetSeries, lookupByTitle, planAdd, setMonitored, sonarrSeries } from "../server/services/sonarr.js";
import { jfSeries, jfViews, plexResources, plexSections, plexShows } from "./fixtures/media-servers.ts";
import { json, mockFetch } from "./helpers.ts";
import { quietWarn, writeAnimeList } from "./world.ts";

const getMedia = () => getSettings().media;

/** Sonarr, Radarr and media-server services over a fake network: configuration errors, partial failures, request bodies. */

const SONARR = "http://sonarr.test:8989";
const SONARR2 = "http://sonarr2.test:8989";
const RADARR = "http://radarr.test:7878";
type Net = {
  fail: Record<string, number>;
  tagFail: boolean;
  seen: { method: string; url: string; body: unknown }[];
  lookup: Record<string, unknown[]>;
};
let net: Net;
let mock: ReturnType<typeof mockFetch>;

beforeEach(() => {
  net = { fail: {}, tagFail: false, seen: [], lookup: {} };
  forgetSeries();
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: SONARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/tv", tags: [], searchOnAdd: true },
    sonarrExtra: [],
    radarr: { ...s.radarr, url: RADARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/movies", tags: [3], searchOnAdd: false },
    media: { type: "none", url: "", token: "", userId: "", libraryIds: [] },
  }));
  mock = mockFetch((u, c) => {
    net.seen.push({ method: c.method, url: c.url, body: c.body });
    const host = u.hostname;
    const failure = net.fail[host];
    if (failure) return json({}, failure);
    const p = u.pathname.replace("/api/v3", "");
    if (host === "sonarr.test" || host === "sonarr2.test") {
      if (p === "/series" && c.method === "GET")
        return json(
          host === "sonarr.test"
            ? [{ id: 1, tvdbId: 11, title: "Main", seasons: [] }]
            : [
                { id: 2, tvdbId: 22, title: "Extra", seasons: [] },
                { id: 3, tvdbId: 11, title: "Dup", seasons: [] },
              ],
        );
      if (p === "/series/lookup") return json(net.lookup[decodeURIComponent(u.searchParams.get("term") ?? "")] ?? []);
      if (p === "/series" && c.method === "POST") return json({ id: 9, title: (c.body as { title: string }).title });
      if (p === "/tag") return net.tagFail ? json({}, 500) : c.method === "POST" ? json({ id: 8 }) : json([]);
      if (p === "/qualityprofile") return json([{ id: 4, name: "HD" }]);
      if (p === "/series/1" && c.method === "GET") return json({ id: 1, tvdbId: 11, title: "Main", monitored: false, seasons: [] });
      if (p === "/series/1" && c.method === "PUT") return json({});
    }
    if (host === "radarr.test") {
      if (p === "/movie" && c.method === "GET") return json([{ id: 5, tmdbId: 372058, title: "君の名は。", hasFile: true }]);
      if (p.startsWith("/movie/lookup/tmdb"))
        return u.searchParams.get("tmdbId") === "1" ? json({ title: "Unknown" }) : json({ tmdbId: 372058, title: "君の名は。" });
      if (p.startsWith("/movie/lookup/imdb")) return json({ tmdbId: 372058, title: "君の名は。" });
      if (p === "/movie" && c.method === "POST") return json({ id: 77, title: "君の名は。" });
      if (p === "/tag") return net.tagFail ? json({}, 500) : c.method === "POST" ? json({ id: 9 }) : json([]);
    }
    if (host === "plex.test") {
      if (u.pathname === "/library/sections") return json(plexSections);
      if (u.pathname.endsWith("/all")) return json(plexShows);
      if (u.pathname === "/") return json({ MediaContainer: { friendlyName: "P", version: "1" } });
      if (u.pathname.includes("/children")) return json({ MediaContainer: { Metadata: [] } });
    }
    if (host === "jf.test") {
      if (u.pathname.endsWith("/Views")) return json(jfViews);
      if (u.pathname.includes("/Items")) return json(jfSeries);
      if (u.pathname.startsWith("/Shows/")) return json({ Items: [] });
      if (u.pathname === "/System/Info") return json({ ServerName: "J", Version: "10" });
    }
    if (host === "plex.tv") {
      if (u.pathname.endsWith("/pins")) return json({ id: 1, code: "ABCD" });
      if (u.pathname.endsWith("/pins/1")) return json({ authToken: "acct" });
      if (u.pathname.endsWith("/resources")) return json(plexResources);
    }
  });
});
afterEach(() => mock.restore());

describe("Sonarr service", () => {
  test("series list merges instances, main wins duplicates, and an unreachable extra instance is skipped with a warning", async () => {
    patchSettings((s) => ({ ...s, sonarrExtra: [{ name: "4K", url: SONARR2, apiKey: "k2" }] }));
    forgetSeries();
    const list = await sonarrSeries(true);
    assert.deepEqual(list.map((x) => [x.tvdbId, x.instance]).sort(), [
      [11, ""],
      [22, SONARR2],
    ]);
    net.fail["sonarr2.test"] = 503;
    forgetSeries();
    const { value, warnings } = await quietWarn(() => sonarrSeries(true));
    assert.deepEqual(
      value.map((x) => x.tvdbId),
      [11],
    );
    assert.ok(warnings.some((w) => /"4K" unreachable/.test(w)));
  });

  test("the main Sonarr being down fails the list (nothing cached to fall back on) and is not cached", async () => {
    net.fail["sonarr.test"] = 500;
    await assert.rejects(sonarrSeries(true), /HTTP 500/);
    delete net.fail["sonarr.test"];
    assert.equal((await sonarrSeries()).length, 1);
  });

  test("addSeries: needs a profile and folder; unknown TVDB id is an error; tagging failure does not block the add", async () => {
    net.lookup["tvdb:100"] = [
      {
        tvdbId: 100,
        title: "葬送のフリーレン",
        seasons: [
          { seasonNumber: 1, monitored: false },
          { seasonNumber: 2, monitored: false },
        ],
      },
    ];
    patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, qualityProfileId: null } }));
    await assert.rejects(addSeries(100, 1), /quality profile and root folder/);
    patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, qualityProfileId: 4 } }));
    await assert.rejects(addSeries(555, 1), /found no series for TVDB 555/);
    net.tagFail = true;
    const r = await addSeries(100, 2);
    assert.equal(r.title, "葬送のフリーレン");
    const post = net.seen.filter((x) => x.method === "POST" && x.url.endsWith("/series")).at(-1)!.body as Record<string, unknown>;
    assert.equal(post.seriesType, "anime");
    assert.deepEqual(post.tags, []);
    assert.deepEqual(
      (post.seasons as { seasonNumber: number; monitored: boolean }[]).map((s) => s.monitored),
      [false, true],
      "season 2 only",
    );
    assert.equal(r.waitingForSeason, false);
  });

  test("planAdd reports whether TVDB lists the season and what the add would search", async () => {
    net.lookup["tvdb:100"] = [{ tvdbId: 100, title: "X", year: 2023, seasons: [{ seasonNumber: 1 }] }];
    const listed = await planAdd(100, 1);
    assert.equal(listed.seasonListed, true);
    assert.equal(listed.profile, "HD");
    assert.ok(listed.tags.includes("tastearr"));
    const unlisted = await planAdd(100, 4);
    assert.equal(unlisted.seasonListed, false);
    assert.equal(unlisted.search, false, "nothing listed to search for yet");
    await assert.rejects(planAdd(999, 1), /found no series/);
  });

  test("lookupByTitle: best match first, de-duplicated across title variants, owned shows flagged, CJK terms encoded", async () => {
    net.lookup["Cool Show"] = [
      { tvdbId: 11, title: "Cool Show", year: 2023, seasons: [] },
      { tvdbId: 12, title: "Totally Different", year: 2023, seasons: [] },
    ];
    net.lookup["クールショー"] = [
      { tvdbId: 11, title: "Cool Show", year: 2023, seasons: [] },
      { tvdbId: 0, title: "no id", seasons: [] },
    ];
    const out = await lookupByTitle(["Cool Show", "クールショー", ""], 2023);
    assert.equal(out[0].tvdbId, 11);
    assert.equal(out[0].inLibrary, true, "11 is the main Sonarr's series");
    assert.deepEqual(
      out.map((x) => x.tvdbId),
      [11, 12],
    );
    assert.ok(net.seen.some((x) => x.url.includes(encodeURIComponent("クールショー"))));
  });

  test("setMonitored writes the whole series back with only the flag changed", async () => {
    await setMonitored(1, true);
    const put = net.seen.find((x) => x.method === "PUT")!;
    assert.deepEqual(put.body, { id: 1, tvdbId: 11, title: "Main", monitored: true, seasons: [] });
    await assert.rejects(setMonitored(1, true, "http://gone.test"), /instance was removed/);
  });
});

describe("Radarr service", () => {
  test("movie list is cached; the add needs a profile and folder, finds the movie, tolerates a tagging failure", async () => {
    assert.equal((await radarrMovies(true))[0].title, "君の名は。");
    const calls = net.seen.length;
    await radarrMovies();
    assert.equal(net.seen.length, calls, "second call served from cache");
    net.tagFail = true;
    const r = await addMovie({ tmdbId: 372058 });
    assert.deepEqual(r, { id: 77, title: "君の名は。", alreadyAdded: false });
    const post = net.seen.filter((x) => x.method === "POST" && x.url.endsWith("/movie")).at(-1)!.body as Record<string, unknown>;
    assert.deepEqual(post.tags, [3]);
    assert.equal(post.monitored, true);
    assert.deepEqual(post.addOptions, { searchForMovie: false });
  });

  test("add by IMDb id when there is no TMDB id; junk ids and unknown movies are refused without a write", async () => {
    await addMovie({ imdbId: "tt5311514" });
    assert.ok(net.seen.some((x) => x.url.includes("/movie/lookup/imdb?imdbId=tt5311514")));
    const writes = () => net.seen.filter((x) => x.method === "POST" && x.url.endsWith("/movie")).length;
    const before = writes();
    await assert.rejects(addMovie({ imdbId: "tt1; DROP TABLE" }), /couldn't find this movie/);
    await assert.rejects(addMovie({}), /couldn't find this movie/);
    await assert.rejects(addMovie({ tmdbId: 1 }), /couldn't find this movie/);
    assert.equal(writes(), before);
    patchSettings((s) => ({ ...s, radarr: { ...s.radarr, rootFolderPath: "" } }));
    await assert.rejects(addMovie({ tmdbId: 372058 }), /quality profile and root folder/);
  });

  test("Radarr down: the list fails loudly", async () => {
    net.fail["radarr.test"] = 502;
    await assert.rejects(radarrMovies(true), /HTTP 502/);
  });
});

describe("media server service", () => {
  const plex = () =>
    patchSettings((s) => ({ ...s, media: { type: "plex", url: "http://plex.test:32400", token: "t", userId: "", libraryIds: [] } }));
  const jf = () =>
    patchSettings((s) => ({ ...s, media: { type: "jellyfin", url: "http://jf.test:8096", token: "t", userId: "u1", libraryIds: ["v1"] } }));

  test("nothing configured: no watch history and no libraries, and testing says so", async () => {
    assert.equal((await watchStates()).size, 0);
    assert.deepEqual(await listLibraries(), []);
    await assert.rejects(testMediaServer(getMedia()), /No media server selected/);
  });

  test("Plex: all show libraries are scanned when none are chosen; HAMA ids go through the mapping list", async () => {
    writeAnimeList([{ anidb_id: 4521, tvdb_id: 5555 }]);
    plex();
    const m = await watchStates();
    assert.ok(m.has(424536) && m.has(5555));
    const scanned = net.seen.filter((x) => x.url.includes("/all?")).map((x) => x.url);
    assert.equal(scanned.length, 2, "both show libraries");
  });

  test("Jellyfin: configured libraries only; the server being down fails the call", async () => {
    jf();
    assert.ok((await watchStates()).has(424536));
    net.fail["jf.test"] = 500;
    await assert.rejects(watchStates(), /HTTP 500/);
  });

  test("Plex sign-in: unknown or expired pins are refused; the browser never sees tokens; only the server's own addresses can be chosen", async () => {
    await assert.rejects(checkPlexSignIn(999), /expired/);
    await assert.rejects(choosePlexServer(999, "srv1", "http://x"), /Sign in with Plex first/);
    const pin = await startPlexSignIn();
    const r = await checkPlexSignIn(pin.id);
    assert.equal(r.done, true);
    assert.ok(!JSON.stringify(r).includes("server-token"));
    await assert.rejects(choosePlexServer(pin.id, "nope", "http://192.168.1.5:32400"), /Server not found/);
    await assert.rejects(choosePlexServer(pin.id, "srv1", "http://evil.test:32400"), /server's own addresses/);
    patchSettings((s) => ({ ...s, media: { ...s.media, type: "none", url: "", token: "" } }));
  });
});
