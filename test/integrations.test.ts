import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { db, transaction } from "../server/db.js";
import { eachLimit, SEASON_CONCURRENCY, watchStates } from "../server/mediaserver.js";
import { ntfyTarget, send } from "../server/notify.js";
import { getSettings, patchSettings } from "../server/settings.js";
import { flushPending, handleSonarrWebhook } from "../server/shows.js";
import { monitorSeason, REFRESH_WAIT } from "../server/sonarr.js";
import { context, invalidateContext } from "../server/taste.js";
import { json, mockFetch, sleep } from "./helpers.ts";

const quiet = <T>(fn: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => undefined;
  return fn().finally(() => (console.warn = warn));
};
const setNotify = (n: Partial<ReturnType<typeof getSettings>["notify"]>) =>
  patchSettings((s) => ({ ...s, notify: { ...s.notify, discordWebhook: "", ntfyUrl: "", gotifyUrl: "", gotifyToken: "", ...n } }));

test("ntfy: JSON goes to the server root, keeping a reverse-proxy path prefix", () => {
  assert.deepEqual(ntfyTarget("https://ntfy.sh/my-alerts"), { endpoint: "https://ntfy.sh/", topic: "my-alerts" });
  assert.deepEqual(ntfyTarget("https://example.com/ntfy/my-alerts/"), { endpoint: "https://example.com/ntfy/", topic: "my-alerts" });
  assert.deepEqual(ntfyTarget("http://192.168.1.10:8090/alerts"), { endpoint: "http://192.168.1.10:8090/", topic: "alerts" });
});

test("send() posts to a prefixed ntfy with the token", async () => {
  setNotify({ ntfyUrl: "https://example.com/ntfy/my-alerts", ntfyToken: "tk" });
  const m = mockFetch((u) => (u.hostname === "example.com" ? json({ id: "1" }) : undefined));
  try {
    assert.deepEqual(await send({ title: "T", body: "B" }), ["ntfy"]);
    assert.equal(m.calls[0].url, "https://example.com/ntfy/");
    assert.equal((m.calls[0].body as { topic: string }).topic, "my-alerts");
    assert.equal(m.calls[0].headers.authorization, "Bearer tk");
  } finally {
    m.restore();
  }
});

test("send() refuses a metadata address saved by an older version, without calling it", async () => {
  setNotify({ discordWebhook: "http://169.254.169.254/latest/meta-data" });
  const m = mockFetch(() => json({}));
  try {
    await quiet(() => assert.rejects(send({ title: "T", body: "B" }), /isn't allowed/));
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("batched episode alerts are sent on shutdown instead of being lost", async () => {
  setNotify({ ntfyUrl: "https://ntfy.sh/alerts" });
  const series = {
    title: "Hero Saga",
    tvdbId: 777,
    type: "anime",
    images: [{ coverType: "poster", remoteUrl: "https://img.example/p.jpg" }],
  };
  const m = mockFetch((u) => (u.hostname === "ntfy.sh" ? json({ id: "1" }) : undefined));
  try {
    assert.deepEqual(await handleSonarrWebhook({ eventType: "Download", series, episodes: [{ seasonNumber: 1, episodeNumber: 1 }] }), [
      "queued",
    ]);
    await handleSonarrWebhook({ eventType: "Download", series, episodes: [{ seasonNumber: 1, episodeNumber: 2 }] });
    assert.equal(m.calls.length, 0, "still batching");
    assert.equal(await flushPending(), 1);
    assert.equal(m.calls.length, 1);
    const body = m.calls[0].body as { title: string; message: string };
    assert.equal(body.title, "2 new episodes: Hero Saga");
    assert.match(body.message, /S01E01, S01E02/);
    assert.equal(await flushPending(), 0, "nothing left (and no timer keeps the process alive)");
  } finally {
    m.restore();
  }
});

test("monitoring a season TVDB hasn't listed yet gives up waiting after REFRESH_WAIT, not 60 seconds", async () => {
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, url: "http://192.168.1.10:8989", apiKey: "k" } }));
  const saved = { ...REFRESH_WAIT };
  Object.assign(REFRESH_WAIT, { polls: 3, everyMs: 1 });
  const series = {
    id: 5,
    tvdbId: 555,
    title: "Hero Saga",
    seriesType: "anime",
    status: "continuing",
    monitored: false,
    seasons: [{ seasonNumber: 1, monitored: true }],
  };
  const m = mockFetch((u, c) => {
    const p = u.pathname.replace("/api/v3", "");
    if (p === "/series" && c.method === "GET") return json([series]);
    if (p === "/series/5" && c.method === "GET") return json(series);
    if (p === "/series/5" && c.method === "PUT") return json(c.body);
    if (p === "/command" && c.method === "POST") return json({ id: 9 });
    if (p === "/command/9") return json({ status: "started" });
    return undefined;
  });
  try {
    const r = await monitorSeason(555, 2, true);
    assert.equal(m.calls.filter((c) => c.url.endsWith("/command/9")).length, 3);
    assert.equal(r.waitingForSeason, true);
    assert.equal(r.resumedSeries, true);
    const put = m.calls.find((c) => c.method === "PUT")!.body as { monitored: boolean; monitorNewItems: string };
    assert.equal(put.monitored, true);
    assert.equal(put.monitorNewItems, "all", "Sonarr picks the season up when TVDB lists it");
    assert.equal(
      m.calls.some((c) => c.method === "POST" && (c.body as { name?: string }).name === "SeasonSearch"),
      false,
    );
  } finally {
    Object.assign(REFRESH_WAIT, saved);
    m.restore();
  }
});

test("eachLimit never runs more than the limit at once and visits everything", async () => {
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await eachLimit([...Array(25).keys()], 4, async (i) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(2);
    seen.push(i);
    running--;
  });
  assert.equal(peak, 4);
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [...Array(25).keys()],
  );
  await eachLimit([], 4, async () => assert.fail("no items"));
});

test("Plex watch state: per-season requests run a few at a time, not one after another", async () => {
  patchSettings((s) => ({ ...s, media: { type: "plex", url: "http://192.168.1.10:32400", token: "t", userId: "", libraryIds: ["1"] } }));
  let running = 0;
  let peak = 0;
  const shows = Array.from({ length: 20 }, (_, i) => ({
    ratingKey: String(100 + i),
    title: `Show ${i}`,
    Guid: [{ id: `tvdb://${1000 + i}` }],
    leafCount: 24,
    viewedLeafCount: i % 5 === 0 ? 0 : 6,
  }));
  const m = mockFetch(async (u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    if (u.pathname === "/library/sections/1/all") return json({ MediaContainer: { Metadata: shows } });
    const k = u.pathname.match(/^\/library\/metadata\/(\d+)\/children$/);
    if (!k) return undefined;
    running++;
    peak = Math.max(peak, running);
    await sleep(5);
    running--;
    return json({
      MediaContainer: {
        Metadata: [
          { index: 1, leafCount: 12, viewedLeafCount: 6 },
          { index: 2, leafCount: 12, viewedLeafCount: 0 },
        ],
      },
    });
  });
  try {
    const w = await watchStates();
    assert.equal(w.size, 20);
    assert.ok(peak > 1 && peak <= SEASON_CONCURRENCY, `peak ${peak}`);
    assert.equal(m.calls.filter((c) => c.url.includes("/children")).length, 16, "only shows with progress");
    assert.deepEqual(w.get(1001)?.seasons.get(1), { watched: 6, total: 12 });
    assert.equal(w.get(1000)?.seasons.size, 0);
  } finally {
    patchSettings((s) => ({ ...s, media: { ...s.media, type: "none", url: "", token: "" } }));
    m.restore();
  }
});

test("callers arriving together share one library scan; a change starts a fresh one", async () => {
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, url: "http://192.168.1.10:8989", apiKey: "k" } }));
  let scans = 0;
  const m = mockFetch(async (u) => {
    if (u.hostname === "raw.githubusercontent.com") return json([]);
    if (u.pathname === "/api/v3/series") {
      scans++;
      await sleep(10);
      return json([{ id: 1, tvdbId: 1, title: "A", seriesType: "anime", status: "continuing", monitored: true, seasons: [] }]);
    }
    return undefined;
  });
  try {
    invalidateContext();
    const [a, b, c] = await Promise.all([context(true), context(true), context()]);
    assert.equal(scans, 1);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(await context(), a, "cached afterwards");
    invalidateContext();
    const d = await context(true);
    assert.notEqual(d, a);
    assert.equal(scans, 2);
  } finally {
    m.restore();
  }
});

test("transaction: all or nothing, and nesting joins the outer one", () => {
  db.exec("CREATE TABLE IF NOT EXISTS t_tx (n INTEGER)");
  assert.throws(() =>
    transaction(() => {
      db.prepare("INSERT INTO t_tx VALUES (1)").run();
      transaction(() => db.prepare("INSERT INTO t_tx VALUES (2)").run());
      throw new Error("boom");
    }),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM t_tx").get() as { n: number }).n, 0);
  transaction(() => {
    for (let i = 0; i < 300; i++) db.prepare("INSERT INTO t_tx VALUES (?)").run(i);
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM t_tx").get() as { n: number }).n, 300);
});
