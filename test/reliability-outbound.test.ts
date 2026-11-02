import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { downloadAnimeList } from "../server/adapters/animelists.js";
import { resolveOutbound, resolver, safeFetch } from "../server/adapters/net.js";
import { CONFIG_DIR } from "../server/config.js";
import { AppError } from "../server/core/errors.js";
import { useDiscovered } from "../server/services/discover.js";
import { importMal } from "../server/services/lists.js";
import { testMediaServer, watchStates } from "../server/services/mediaserver.js";
import { addMovie } from "../server/services/radarr.js";
import { patchSettings } from "../server/services/settings.js";
import { addSeries, setMonitored } from "../server/services/sonarr.js";
import { json, mockFetch } from "./helpers.ts";

/** Outbound address checks after DNS, redirects, idempotent Sonarr/Radarr adds, mapping-list safety, Plex/Jellyfin ids. */

const realLookup = resolver.lookup;
const withDns = async (table: Record<string, string>, fn: () => Promise<void>) => {
  resolver.lookup = async (h) => {
    if (!(h in table)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return [{ address: table[h], family: table[h].includes(":") ? 6 : 4 }];
  };
  try {
    await fn();
  } finally {
    resolver.lookup = realLookup;
  }
};

test("a hostname resolving to link-local / cloud metadata is refused; LAN and Docker names are allowed", async () => {
  await withDns(
    { "evil.example": "169.254.169.254", "aws6.example": "fd00:ec2::254", "sonarr.lan": "192.168.1.10", sonarr: "172.18.0.5" },
    async () => {
      await assert.rejects(resolveOutbound("http://evil.example:8989", "The Sonarr address"), /points to 169\.254\.169\.254/);
      await assert.rejects(resolveOutbound("http://aws6.example/", "X"), /points to fd00:ec2::254/);
      assert.equal((await resolveOutbound("http://sonarr.lan:8989")).hostname, "sonarr.lan");
      assert.equal((await resolveOutbound("http://sonarr:8989")).hostname, "sonarr");
      assert.equal((await resolveOutbound("http://10.0.0.5:8989")).hostname, "10.0.0.5", "IP literal, no lookup");
      await assert.rejects(resolveOutbound("http://nowhere.lan", "The Sonarr address"), /can't find the host "nowhere\.lan" \(ENOTFOUND\)/);
    },
  );
});

test("a saved Sonarr address whose name points at the metadata service is never called, so the key isn't sent", async () => {
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: "http://evil.example:8989", apiKey: "secret", qualityProfileId: 1, rootFolderPath: "/tv" },
  }));
  const m = mockFetch(() => json([]));
  try {
    await withDns({ "evil.example": "169.254.169.254" }, async () => {
      await assert.rejects(addSeries(1, 1), /isn't allowed/);
    });
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("redirects: same host is followed; another host is refused without sending the key there", async () => {
  const m = mockFetch((u, c) => {
    if (u.href === "http://sonarr.lan/api") return new Response(null, { status: 301, headers: { location: "https://sonarr.lan/api" } });
    if (u.href === "https://sonarr.lan/api") return json({ ok: true, key: c.headers["x-api-key"] });
    if (u.href === "http://moved.lan/api") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    if (u.href === "http://other.lan/api") return new Response(null, { status: 302, headers: { location: "http://attacker.example/" } });
    return undefined;
  });
  try {
    const r = await safeFetch("http://sonarr.lan/api", { headers: { "X-Api-Key": "k" } }, "The Sonarr address");
    assert.deepEqual(await r.json(), { ok: true, key: "k" });
    await assert.rejects(
      safeFetch("http://other.lan/api", { headers: { "X-Api-Key": "k" } }, "The Sonarr address"),
      /redirects to http:\/\/attacker\.example/,
    );
    await assert.rejects(safeFetch("http://moved.lan/api", {}, "X"), /redirects to http:\/\/169\.254\.169\.254/);
    assert.ok(!m.calls.some((c) => c.url.includes("attacker") || c.url.includes("169.254")), "never followed");
  } finally {
    m.restore();
  }
});

test("redirects: a POST answered with 302 is refused instead of silently becoming a GET; 307 keeps the POST", async () => {
  const m = mockFetch((u) => {
    if (u.pathname === "/a") return new Response(null, { status: 302, headers: { location: "/b" } });
    if (u.pathname === "/c") return new Response(null, { status: 307, headers: { location: "/d" } });
    if (u.pathname === "/d") return json({ posted: true });
    return undefined;
  });
  try {
    await assert.rejects(safeFetch("http://ntfy.lan/a", { method: "POST", body: "{}" }, "The ntfy address"), /redirects/);
    assert.equal(m.calls.length, 1, "no GET to /b");
    const r = await safeFetch("http://ntfy.lan/c", { method: "POST", body: "{}" }, "The ntfy address");
    assert.deepEqual(await r.json(), { posted: true });
    assert.equal(m.calls.at(-1)!.method, "POST");
  } finally {
    m.restore();
  }
});

// --- Idempotent adds

const sonarrConn = { url: "http://192.168.1.10:8989", apiKey: "k", qualityProfileId: 1, rootFolderPath: "/tv" };
const lookupHit = (over: Record<string, unknown> = {}) => [
  { tvdbId: 321, title: "Hero Saga", seasons: [{ seasonNumber: 1, monitored: false }], ...over },
];

test("Sonarr add: a series already in the library is reported, not added again", async () => {
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, ...sonarrConn } }));
  const m = mockFetch((u) => (u.pathname === "/api/v3/series/lookup" ? json(lookupHit({ id: 44 })) : undefined));
  try {
    const r = await addSeries(321, 1);
    assert.deepEqual(r, { id: 44, title: "Hero Saga", monitored: "Already in Sonarr", waitingForSeason: false, alreadyAdded: true });
    assert.ok(!m.calls.some((c) => c.method === "POST"));
  } finally {
    m.restore();
  }
});

test("Sonarr add: when the POST times out but Sonarr did add it, the add counts as done", async () => {
  const m = mockFetch((u, c) => {
    const p = u.pathname.replace("/api/v3", "");
    if (p === "/series/lookup") return json(lookupHit());
    if (p === "/tag" && c.method === "GET") return json([{ id: 3, label: "tastearr" }]);
    if (p === "/series" && c.method === "POST") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (p === "/series" && c.method === "GET") {
      assert.equal(u.searchParams.get("tvdbId"), "321");
      return json([{ id: 45, tvdbId: 321, title: "Hero Saga", seasons: [] }]);
    }
    return undefined;
  });
  try {
    const r = await addSeries(321, 1);
    assert.equal(r.id, 45);
    assert.equal(r.alreadyAdded, false);
    assert.equal(m.calls.filter((c) => c.method === "POST" && c.url.endsWith("/series")).length, 1, "no second POST");
  } finally {
    m.restore();
  }
});

test("Sonarr add: a real refusal (not there afterwards) still fails", async () => {
  const m = mockFetch((u, c) => {
    const p = u.pathname.replace("/api/v3", "");
    if (p === "/series/lookup") return json(lookupHit());
    if (p === "/tag" && c.method === "GET") return json([{ id: 3, label: "tastearr" }]);
    if (p === "/series" && c.method === "POST") return json([{ errorMessage: "Root folder doesn't exist" }], 400);
    if (p === "/series" && c.method === "GET") return json([{ id: 9, tvdbId: 999, title: "Other" }]);
    return undefined;
  });
  try {
    await assert.rejects(addSeries(321, 1), /POST \/series failed \(HTTP 400\)/);
  } finally {
    m.restore();
  }
});

test("tag: two adds racing to create the tastearr tag both end up using the one that exists", async () => {
  let made = false;
  const m = mockFetch((u, c) => {
    const p = u.pathname.replace("/api/v3", "");
    if (p === "/series/lookup") return json(lookupHit());
    if (p === "/tag" && c.method === "GET") return json(made ? [{ id: 8, label: "Tastearr" }] : []);
    if (p === "/tag" && c.method === "POST") {
      made = true; // the other add created it first
      return json([{ errorMessage: "Tag already exists" }], 400);
    }
    if (p === "/series" && c.method === "POST") return json({ id: 50, title: "Hero Saga", tags: (c.body as { tags: number[] }).tags });
    return undefined;
  });
  try {
    await addSeries(321, 1);
    const post = m.calls.find((c) => c.method === "POST" && c.url.endsWith("/series"))!;
    assert.deepEqual((post.body as { tags: number[] }).tags, [8]);
  } finally {
    m.restore();
  }
});

test("Radarr add: already in the library, or added despite a timeout, is not added twice", async () => {
  patchSettings((s) => ({
    ...s,
    radarr: { ...s.radarr, url: "http://192.168.1.11:7878", apiKey: "k", qualityProfileId: 1, rootFolderPath: "/movies" },
  }));
  let m = mockFetch((u) => (u.pathname === "/api/v3/movie/lookup/tmdb" ? json({ id: 12, tmdbId: 900, title: "Film" }) : undefined));
  try {
    assert.deepEqual(await addMovie({ tmdbId: 900 }), { id: 12, title: "Film", alreadyAdded: true });
    assert.ok(!m.calls.some((c) => c.method === "POST"));
  } finally {
    m.restore();
  }
  m = mockFetch((u, c) => {
    const p = u.pathname.replace("/api/v3", "");
    if (p === "/movie/lookup/tmdb") return json({ tmdbId: 900, title: "Film" });
    if (p === "/tag") return json([{ id: 1, label: "tastearr" }]);
    if (p === "/movie" && c.method === "POST") throw new TypeError("fetch failed");
    if (p === "/movie" && c.method === "GET") return json([{ id: 13, tmdbId: 900, title: "Film" }]);
    return undefined;
  });
  try {
    assert.deepEqual(await addMovie({ tmdbId: 900 }), { id: 13, title: "Film", alreadyAdded: false });
  } finally {
    m.restore();
  }
});

// --- Mapping list download

test("a garbled or much smaller anime list download never replaces the good copy", async () => {
  const file = path.join(CONFIG_DIR, "list-test.json");
  const good = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ anilist_id: i + 1, tvdb_id: 1000 + i })));
  fs.writeFileSync(file, good);
  const bodies = ["<html>Rate limited</html>", '{"message":"Not Found"}', good.slice(0, good.length / 2), "[]"];
  for (const body of bodies) {
    const m = mockFetch((u) => (u.hostname === "raw.githubusercontent.com" ? new Response(body, { status: 200 }) : undefined));
    try {
      await assert.rejects(downloadAnimeList(file));
      assert.equal(fs.readFileSync(file, "utf8"), good, `kept after: ${body.slice(0, 30)}`);
    } finally {
      m.restore();
    }
  }
  assert.deepEqual(
    fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

// --- Media servers: shows matched without a TVDB id

const LIST = [
  { anilist_id: 1, tvdb_id: 100, themoviedb_id: { tv: 5550 }, imdb_id: "tt0100" },
  { anilist_id: 2, tvdb_id: 200, anidb_id: 77 },
  { anilist_id: 3, tvdb_id: 300 },
];

test("Plex: shows matched by TMDB, IMDb (new or legacy agent) or HAMA AniDB still count as watched", async () => {
  patchSettings((s) => ({ ...s, media: { ...s.media, type: "plex", url: "http://192.168.1.9:32400", token: "t", libraryIds: ["1"] } }));
  const shows = [
    { ratingKey: "1", title: "By TMDB", Guid: [{ id: "tmdb://5550" }], leafCount: 12, viewedLeafCount: 0 },
    { ratingKey: "2", title: "By AniDB", guid: "com.plexapp.agents.hama://anidb-77?lang=en", leafCount: 12, viewedLeafCount: 0 },
    { ratingKey: "3", title: "By TVDB", Guid: [{ id: "imdb://tt9" }, { id: "tvdb://300" }], leafCount: 12, viewedLeafCount: 0 },
    { ratingKey: "4", title: "Unknown", Guid: [{ id: "tmdb://1" }], leafCount: 12, viewedLeafCount: 0 },
    { ratingKey: "5", title: "Legacy IMDb", guid: "com.plexapp.agents.imdb://tt0100?lang=en", leafCount: 12, viewedLeafCount: 0 },
    // A watched HAMA season entry and an unwatched one on the same TVDB series: the watched one must win.
    { ratingKey: "6", title: "HAMA S2", guid: "com.plexapp.agents.hama://anidb-77?lang=en", leafCount: 12, viewedLeafCount: 9 },
    { ratingKey: "7", title: "HAMA S3", guid: "com.plexapp.agents.hama://anidb-77?lang=en", leafCount: 12, viewedLeafCount: 0 },
  ];
  const m = mockFetch((u) => {
    if (u.hostname === "raw.githubusercontent.com") return json(LIST);
    if (u.pathname === "/library/sections/1/all") return json({ MediaContainer: { Metadata: shows } });
    if (u.pathname === "/library/metadata/6/children")
      return json({ MediaContainer: { Metadata: [{ index: 1, leafCount: 12, viewedLeafCount: 9 }] } });
    return undefined;
  });
  try {
    const w = await watchStates();
    assert.deepEqual([...w.keys()].sort(), [100, 200, 300]);
    assert.equal(w.get(100)!.title, "By TMDB", "an equally unwatched duplicate doesn't replace the first match");
    assert.equal(w.get(200)!.title, "HAMA S2", "the watched entry wins over unwatched ones");
    assert.equal(w.get(200)!.watched, 9);
  } finally {
    m.restore();
  }
});

test("Jellyfin: TMDB / IMDb / AniDB provider ids fall back to TVDB through the mapping", async () => {
  patchSettings((s) => ({
    ...s,
    media: { ...s.media, type: "jellyfin", url: "http://192.168.1.9:8096", token: "t", userId: "u1", libraryIds: ["L"] },
  }));
  const items = [
    { Id: "a", Name: "A", ProviderIds: { Tmdb: "5550" }, RecursiveItemCount: 12, UserData: { UnplayedItemCount: 12 } },
    { Id: "b", Name: "B", ProviderIds: { AniDB: "77" }, RecursiveItemCount: 12, UserData: { UnplayedItemCount: 12 } },
    { Id: "c", Name: "C", ProviderIds: { Imdb: "tt404" }, RecursiveItemCount: 12, UserData: { UnplayedItemCount: 12 } },
  ];
  const m = mockFetch((u) => (u.pathname === "/Users/u1/Items" ? json({ Items: items }) : undefined));
  try {
    const w = await watchStates();
    assert.deepEqual([...w.keys()].sort(), [100, 200]);
  } finally {
    patchSettings((s) => ({ ...s, media: { ...s.media, type: "none", url: "", token: "", userId: "", libraryIds: [] } }));
    m.restore();
  }
});

// --- User-caused failures answer 4xx, not 500

const status = async (p: Promise<unknown>, code: number, msg: RegExp) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AppError, `AppError, got ${String(e)}`);
    assert.equal(e.statusCode, code);
    assert.match(e.message, msg);
    return true;
  });
};

test("user-caused errors carry a 4xx status: missing setup, unknown ids, stale instances", async () => {
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, qualityProfileId: null }, radarr: { ...s.radarr, rootFolderPath: "" } }));
  await status(addSeries(1, 1), 400, /quality profile/);
  await status(addMovie({ tmdbId: 1 }), 400, /quality profile/);
  await status(useDiscovered("gone-id", "http://192.168.1.10:8989", true), 404, /no longer detected/);
  await status(setMonitored(1, true, "http://192.168.9.9:8989"), 409, /instance was removed/);
  await status(importMal("me", ""), 400, /client ID/);
  await status(testMediaServer({ type: "none", url: "", token: "", userId: "", libraryIds: [] }), 400, /No media server/);
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, url: "", apiKey: "", qualityProfileId: 1, rootFolderPath: "/tv" } }));
  await status(addSeries(1, 1), 400, /Sonarr is not configured/);
  // A genuine outside failure stays a plain error (500).
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, ...sonarrConn } }));
  const m = mockFetch(() => new Response("", { status: 500 }));
  try {
    await assert.rejects(addSeries(1, 1), (e: unknown) => !(e instanceof AppError));
  } finally {
    m.restore();
  }
});

test("Sonarr finding no series for a TVDB id is a 404", async () => {
  const m = mockFetch((u) => (u.pathname === "/api/v3/series/lookup" ? json([]) : undefined));
  try {
    await status(addSeries(424242, 1), 404, /no series for TVDB 424242/);
  } finally {
    m.restore();
  }
});
