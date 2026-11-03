import "./env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ScoredPick, TasteProfile } from "../shared/api.js";
import { defaultMonitor, planSeriesAdd } from "../server/core/add-plan.js";
import { episodeAlert, episodeCode } from "../server/core/alerts.js";
import { selectAutoAdd } from "../server/core/autoadd.js";
import { eachLimit } from "../server/core/concurrency.js";
import { AppError, parseId } from "../server/core/errors.js";
import { buildTables, isFirstOfMany, place, type AnimeListRow } from "../server/core/mapping.js";
import { inCidr, isHomeNetwork, isLoopback, isPrivateHost, isPrivateIp } from "../server/core/network.js";
import { OutboundError } from "../server/core/outbound.js";
import { applyUpdate, loadSettings, MASK, toPublicSettings } from "../server/core/settings.js";
import { SEASONS, seasonIdx, seasonOf, shiftSeason, type Media } from "../server/core/taste/media.js";
import { scoreCandidates, toMatch } from "../server/core/taste/score.js";
import { inferMapping } from "../server/core/taste/sequels.js";
import type { LibrarySeries, TasteEnv } from "../server/core/taste/types.js";
import { emptyCtx, media, tags } from "./helpers.ts";

/** Property-style tests: many seeded random inputs, asserting what must hold for every one of them. */

/** Small deterministic PRNG so a failure reproduces from the printed seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    some: <T>(xs: readonly T[], n: number): T[] => [...xs].sort(() => next() - 0.5).slice(0, n),
  };
}

const GENRES = ["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Horror"];
const TAGS = [
  "Isekai",
  "Magic",
  "Swordplay",
  "School",
  "Demons",
  "Time Loop",
  "Mecha",
  "Idol",
  "Cooking",
  "Reincarnation",
  "Villainess",
  "Military",
];
const FORMATS = ["TV", "TV_SHORT", "ONA", "MOVIE"];
const STATUSES = ["NOT_YET_RELEASED", "RELEASING", "FINISHED"];

function randomMedia(r: ReturnType<typeof rng>, id: number): Media {
  return media(id, {
    genres: r.some(GENRES, r.int(0, 4)),
    tags: tags(...r.some(TAGS, r.int(0, 8))),
    popularity: r.pick([0, 1, 50, 800, 5000, 90000, 400000]),
    format: r.pick(FORMATS),
    status: r.pick(STATUSES),
    episodes: r.pick([null, 1, 6, 12, 24, 100]),
    duration: r.pick([null, 3, 24]),
    averageScore: r.pick([null, 55, 80]),
    title: { romaji: `Show ${id}`, english: r.pick([null, `Show ${id}`]), native: r.pick([null, `作品${id}`]) },
  });
}

function randomProfile(r: ReturnType<typeof rng>): TasteProfile {
  const features: TasteProfile["features"] = {};
  for (const g of GENRES) if (r.next() < 0.7) features[`G:${g}`] = { lift: 0.05 + r.next() * 5, n: 20, p: 5 };
  for (const t of TAGS) if (r.next() < 0.7) features[`T:${t}`] = { lift: 0.05 + r.next() * 5, n: 20, p: 5 };
  return { builtAt: 0, trainedOn: 300, positives: 50, known: 100, base: 0.2, features, favourites: [], sources: {} };
}

const env = (candidates: Media[]): TasteEnv => {
  const byId = new Map(candidates.map((m) => [m.id, m]));
  return {
    media: (id) => byId.get(id) ?? null,
    config: {
      training: { seasons: 8, minTagRank: 60, formats: ["TV"], countries: ["JP"] },
      filters: { excludeGenres: [], excludeTags: [], noGore: false },
      genrePrefs: {},
      titleLanguage: "english",
      sonarrOn: false,
      radarrOn: false,
      tune: {},
    },
  };
};

const ROUNDS = 40;

describe("taste scoring invariants", () => {
  test("scores are finite, matches are integers in 0..100, for any candidates, profile and verdicts", () => {
    for (let seed = 1; seed <= ROUNDS; seed++) {
      const r = rng(seed);
      const cands = Array.from({ length: r.int(0, 25) }, (_, i) => randomMedia(r, i + 1));
      const ctx = emptyCtx({
        fb: new Map(
          cands.filter(() => r.next() < 0.3).map((m) => [m.id, r.pick(["loved", "liked", "meh", "disliked", "hidden", "added"])]),
        ),
      });
      const picks = scoreCandidates(cands, randomProfile(r), ctx, env(cands));
      assert.equal(picks.length, cands.length, `seed ${seed}`);
      for (const p of picks) {
        assert.ok(Number.isFinite(p.score), `seed ${seed}: score ${p.score}`);
        assert.ok(Number.isInteger(p.match) && p.match >= 0 && p.match <= 100, `seed ${seed}: match ${p.match}`);
      }
    }
  });

  test("deterministic, and never mutates its inputs", () => {
    for (let seed = 100; seed < 100 + ROUNDS; seed++) {
      const r = rng(seed);
      const cands = Array.from({ length: 12 }, (_, i) => randomMedia(r, i + 1));
      const profile = randomProfile(r);
      const ctx = emptyCtx();
      const snap = structuredClone({ cands, profile });
      const a = scoreCandidates(cands, profile, ctx, env(cands));
      const b = scoreCandidates(cands, profile, ctx, env(cands));
      assert.deepEqual(a, b, `seed ${seed}`);
      assert.deepEqual({ cands, profile }, snap, `seed ${seed}: inputs mutated`);
    }
  });

  test("a thumbs-down or hide never raises a score or a match; a thumbs-up never lowers one", () => {
    for (let seed = 200; seed < 200 + ROUNDS; seed++) {
      const r = rng(seed);
      const cands = Array.from({ length: 10 }, (_, i) => randomMedia(r, i + 1));
      const profile = randomProfile(r);
      const base = scoreCandidates(cands, profile, emptyCtx(), env(cands));
      for (const [verdict, dir] of [
        ["disliked", -1],
        ["hidden", -1],
        ["loved", 1],
        ["liked", 1],
      ] as const) {
        const fb = new Map(cands.map((m) => [m.id, verdict]));
        const after = scoreCandidates(cands, profile, emptyCtx({ fb }), env(cands));
        after.forEach((p, i) => {
          if (dir < 0) {
            assert.ok(p.score <= base[i].score + 1e-9, `seed ${seed} ${verdict}: score rose ${base[i].score} -> ${p.score}`);
            assert.ok(p.match <= base[i].match, `seed ${seed} ${verdict}: match rose`);
          } else {
            assert.ok(p.score >= base[i].score - 1e-9, `seed ${seed} ${verdict}: score fell`);
            assert.ok(p.match >= base[i].match, `seed ${seed} ${verdict}: match fell`);
          }
        });
      }
    }
  });

  test("a disliked or hidden show is always excluded; a 'seen' show is excluded too", () => {
    for (let seed = 300; seed < 300 + 15; seed++) {
      const r = rng(seed);
      const cands = Array.from({ length: 8 }, (_, i) => randomMedia(r, i + 1));
      for (const v of ["disliked", "hidden"]) {
        const picks = scoreCandidates(cands, randomProfile(r), emptyCtx({ fb: new Map(cands.map((m) => [m.id, v])) }), env(cands));
        assert.ok(
          picks.every((p) => p.excluded),
          `seed ${seed} ${v}`,
        );
      }
      const lists = new Map(cands.map((m) => [m.id, { id: m.id, source: "anilist", status: "COMPLETED", score: 90, progress: 12 }]));
      const finished = cands.map((m) => ({ ...m, status: "FINISHED", nextAiringEpisode: null }));
      const picks = scoreCandidates(finished, randomProfile(r), emptyCtx({ lists }), env(finished));
      assert.ok(
        picks.every((p) => p.myStatus === "seen" && p.excluded),
        `seed ${seed} seen`,
      );
    }
  });

  test("raising every feature's lift never lowers a show's score (taste is monotone in the profile)", () => {
    for (let seed = 400; seed < 400 + ROUNDS; seed++) {
      const r = rng(seed);
      const cands = Array.from({ length: 10 }, (_, i) => randomMedia(r, i + 1));
      const profile = randomProfile(r);
      const higher: TasteProfile = {
        ...profile,
        features: Object.fromEntries(Object.entries(profile.features).map(([k, v]) => [k, { ...v, lift: v.lift * 1.5 }])),
      };
      const a = scoreCandidates(cands, profile, emptyCtx(), env(cands));
      const b = scoreCandidates(cands, higher, emptyCtx(), env(cands));
      b.forEach((p, i) => assert.ok(p.score >= a[i].score - 1e-9, `seed ${seed}: ${a[i].score} -> ${p.score}`));
    }
  });

  test("an empty profile and an empty candidate list are fine", () => {
    assert.deepEqual(scoreCandidates([], randomProfile(rng(1)), emptyCtx(), env([])), []);
    const m = [randomMedia(rng(2), 1)];
    const p = scoreCandidates(
      m,
      { builtAt: 0, trainedOn: 0, positives: 0, known: 0, base: 0, features: {}, favourites: [], sources: {} },
      emptyCtx({ hasHistory: false }),
      env(m),
    );
    assert.ok(p[0].match >= 0 && p[0].match <= 100);
  });

  test("toMatch: bounded, integer, monotone non-decreasing, 50 at the midpoint, survives extremes", () => {
    let last = -1;
    for (let s = -50; s <= 50; s += 0.25) {
      const m = toMatch(s);
      assert.ok(Number.isInteger(m) && m >= 0 && m <= 100);
      assert.ok(m >= last, `not monotone at ${s}`);
      last = m;
    }
    assert.equal(toMatch(4.6), 50);
    assert.equal(toMatch(1e9), 100);
    assert.equal(toMatch(-1e9), 0);
    assert.equal(toMatch(Number.POSITIVE_INFINITY), 100);
    assert.equal(toMatch(Number.NEGATIVE_INFINITY), 0);
  });
});

describe("seasons", () => {
  test("shiftSeason: +n then -n is the identity, one step is one season, index is consecutive", () => {
    for (let seed = 1; seed <= ROUNDS; seed++) {
      const r = rng(seed);
      const s = { season: r.pick(SEASONS), year: r.int(1980, 2100) };
      const n = r.int(-50, 50);
      assert.deepEqual(shiftSeason(shiftSeason(s, n), -n), s);
      assert.equal(seasonIdx(shiftSeason(s, n)) - seasonIdx(s), n);
    }
    assert.deepEqual(shiftSeason({ season: "FALL", year: 2025 }, 1), { season: "WINTER", year: 2026 });
    assert.deepEqual(shiftSeason({ season: "WINTER", year: 2025 }, -1), { season: "FALL", year: 2024 });
  });

  test("seasonOf: every month maps to its quarter, including year edges", () => {
    const exp = ["WINTER", "WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER", "SUMMER", "SUMMER", "FALL", "FALL", "FALL"];
    exp.forEach((s, m) => assert.deepEqual(seasonOf(new Date(2026, m, 15)), { season: s, year: 2026 }));
    assert.deepEqual(seasonOf(new Date(2026, 11, 31, 23, 59)), { season: "FALL", year: 2026 });
    assert.deepEqual(seasonOf(new Date(2027, 0, 1, 0, 0)), { season: "WINTER", year: 2027 });
  });
});

describe("mapping tables", () => {
  const row = (anilist_id: number, tvdb_id: number, season?: number, extra: Partial<AnimeListRow> = {}): AnimeListRow => ({
    anilist_id,
    tvdb_id,
    season: season === undefined ? undefined : { tvdb: season },
    ...extra,
  });

  test("random lists and overrides keep byAnilist and byTvdb consistent with each other", () => {
    for (let seed = 1; seed <= ROUNDS; seed++) {
      const r = rng(seed);
      // Unique AniList ids per row: duplicates are the separate todo below.
      const ids = r.some(
        Array.from({ length: 40 }, (_, i) => i + 1),
        r.int(0, 30),
      );
      const rows: AnimeListRow[] = ids.map((id) => row(id, r.int(1, 15), r.pick([undefined, 1, 2, 3])));
      const overrides = Array.from({ length: r.int(0, 10) }, () => ({
        anilistId: r.int(1, 40),
        mapping: { tvdbId: r.int(1, 20), season: r.pick([null, 1, 2]) },
      }));
      const t = buildTables(rows, overrides);
      for (const [a, m] of t.byAnilist) assert.ok(t.byTvdb.get(m.tvdbId)?.includes(a), `seed ${seed}: ${a} missing under tvdb ${m.tvdbId}`);
      for (const [tvdb, ids] of t.byTvdb) {
        assert.equal(new Set(ids).size, ids.length, `seed ${seed}: duplicate ids under ${tvdb}`);
        for (const a of ids) assert.equal(t.byAnilist.get(a)?.tvdbId, tvdb, `seed ${seed}: ${a} listed under ${tvdb} but mapped elsewhere`);
      }
      for (const o of overrides.slice().reverse().slice(0, 1))
        assert.deepEqual(t.byAnilist.get(o.anilistId), o.mapping, `seed ${seed}: last override wins`);
    }
  });

  test("untidy rows: missing ids, empty arrays, string or array imdb, duplicate rows, tvdb without anilist", () => {
    const t = buildTables(
      [
        {},
        { anilist_id: 1 },
        { tvdb_id: 5 },
        { anilist_id: 2, tvdb_id: 7, imdb_id: [], themoviedb_id: { movie: [] } },
        { anilist_id: 3, imdb_id: "tt1", themoviedb_id: { movie: [10, 11] } },
        { anilist_id: 4, imdb_id: ["tt2", "tt3"], themoviedb_id: { movie: 10 } },
        row(8, 70, 1),
        row(8, 71, 2), // the same AniList id listed twice: last wins
        { anilist_id: 9, tvdb_id: 0 },
        { anilist_id: 10, mal_id: 0 },
      ],
      [],
    );
    assert.equal(t.byAnilist.size, 2);
    assert.deepEqual(t.byAnilist.get(8), { tvdbId: 71, season: 2 });
    assert.equal(t.imdbByAnilist.get(3), "tt1");
    assert.equal(t.imdbByAnilist.get(4), "tt2");
    assert.equal(t.movieByAnilist.get(3), 10);
    assert.deepEqual(t.anilistByMovie.get(10), [3, 4]);
    assert.equal(t.movieByAnilist.has(2), false);
    assert.equal(t.byMal.size, 0);
    assert.equal(t.byAnilist.has(9), false);
  });

  test("an AniList id listed twice with different TVDB ids leaves the first series' byTvdb list (was todo #4)", () => {
    const t = buildTables([row(8, 70, 1), row(1, 70, 1), row(8, 71, 2)], []);
    assert.deepEqual(t.byTvdb.get(70), [1], "no longer listed under the series it moved away from");
    assert.deepEqual(t.byTvdb.get(71), [8]);
    assert.deepEqual(t.byAnilist.get(8), { tvdbId: 71, season: 2 });
  });

  test("an AniList id listed twice for the same series appears once in its byTvdb list", () => {
    const t = buildTables([row(8, 70, 1), row(8, 70, 2)], []);
    assert.deepEqual(t.byTvdb.get(70), [8]);
    assert.deepEqual(t.byAnilist.get(8), { tvdbId: 70, season: 2 });
  });

  test("fix review #7: a series left with no AniList entries is no longer in byTvdb (it isn't 'claimed')", () => {
    const t = buildTables([row(1, 10, 1), row(1, 20, 1)], []);
    assert.equal(t.byTvdb.has(10), false, "listed twice: the first series keeps no empty entry");
    assert.deepEqual(t.byTvdb.get(20), [1]);
    place(t, 1, { tvdbId: 30, season: 1 });
    assert.equal(t.byTvdb.has(20), false, "a hand-picked match moving the last entry away");
  });

  test("fix review #7: a new show matches an owned series that only an earlier, moved-away list entry pointed at", () => {
    const t = buildTables([row(1, 10, 1), row(1, 20, 1)], []);
    const owned = { tvdbId: 10, title: "Hoshi no Tabi", seriesType: "anime", year: 2030, seasons: [{ seasonNumber: 1 }] };
    const ctx = emptyCtx({ lib: new Map([[10, owned as never]]), byTvdb: t.byTvdb, byAnilist: t.byAnilist });
    const m = media(500, { title: { romaji: "Hoshi no Tabi", english: null, native: null }, seasonYear: 2030 });
    assert.deepEqual(inferMapping(m, null, ctx), { tvdbId: 10, season: 1 });
  });

  test("place: moving an id removes it from the old series, is idempotent, and works for unseen ids", () => {
    const t = buildTables([row(1, 100, 1), row(2, 100, 2)], []);
    place(t, 2, { tvdbId: 200, season: 1 });
    assert.deepEqual(t.byTvdb.get(100), [1]);
    assert.deepEqual(t.byTvdb.get(200), [2]);
    place(t, 2, { tvdbId: 200, season: 1 });
    assert.deepEqual(t.byTvdb.get(200), [2]);
    place(t, 77, { tvdbId: 100, season: null });
    assert.deepEqual(t.byTvdb.get(100), [1, 77]);
    place(t, 77, { tvdbId: 100, season: 3 });
    assert.deepEqual(t.byTvdb.get(100), [1, 77]);
    assert.equal(t.byAnilist.get(77)!.season, 3);
  });

  test("isFirstOfMany: long runners and multi-year spans, nothing for empty or unknown data", () => {
    const e = (episodes: number | null, seasonYear: number | null) => ({ episodes, seasonYear });
    assert.equal(isFirstOfMany([]), false);
    assert.equal(isFirstOfMany([e(null, null)]), false);
    assert.equal(isFirstOfMany([e(51, 2000)]), true);
    assert.equal(isFirstOfMany([e(50, 2000)]), false);
    assert.equal(isFirstOfMany([e(12, 2018), e(12, 2020)]), false);
    assert.equal(isFirstOfMany([e(12, 2018), e(12, 2021)]), true);
    assert.equal(
      isFirstOfMany([
        e(12, null),
        { episodes: 12, seasonYear: null, startDate: { year: 2010 } },
        { episodes: 12, seasonYear: null, startDate: { year: 2014 } },
      ]),
      true,
    );
  });
});

describe("settings update", () => {
  const { settings: base } = loadSettings({});
  const junk = (r: ReturnType<typeof rng>): unknown =>
    r.pick<() => unknown>([
      () => null,
      () => 42,
      () => "str",
      () => [1, 2],
      () => ({ sonarr: r.pick([null, "x", [], { url: 5 }, { url: "http://192.168.1.2:8989", apiKey: {} }]) }),
      () => ({ training: { seasons: r.pick(["9999", -5, NaN, "abc", null, 3.7]) } }),
      () => ({ autoAdd: { minMatch: r.pick([0, 500, "75"]), enabled: r.pick(["yes", true, 1]) } }),
      () => ({ notify: { ntfyUrl: r.pick(["", "my-topic", "ntfy.sh/x", "http://169.254.169.254/x", "javascript:alert(1)"]) } }),
      () => ({ __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } }),
      () => JSON.parse('{"__proto__":{"polluted":true},"media":{"type":"ftp"}}'),
    ])();

  test("fuzzed input either yields valid settings or a 400 OutboundError; ranges hold; prototypes are never polluted", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      try {
        const next = applyUpdate(base, junk(r));
        assert.ok(next.training.seasons >= 2 && next.training.seasons <= 24, `seed ${seed}`);
        assert.ok(next.autoAdd.minMatch >= 50 && next.autoAdd.minMatch <= 100);
        assert.ok(["none", "plex", "jellyfin"].includes(next.media.type));
        assert.equal(typeof next.autoAdd.enabled, "boolean");
        assert.equal(typeof next.sonarr.url, "string");
      } catch (e) {
        assert.ok(e instanceof OutboundError && e.statusCode === 400, `seed ${seed}: unexpected ${(e as Error).stack}`);
      }
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test("a masked secret means unchanged, public settings never contain a secret, a changed address drops its old key", () => {
    const s = structuredClone(base);
    s.sonarr = { ...s.sonarr, url: "http://192.168.1.2:8989", apiKey: "real-key" };
    const pub = toPublicSettings(s);
    assert.equal(pub.sonarr.apiKey, MASK);
    assert.ok(!JSON.stringify(pub).includes("real-key"));
    assert.ok(!JSON.stringify(pub).includes(s.secret));
    assert.equal(applyUpdate(s, { sonarr: { apiKey: MASK } }).sonarr.apiKey, "real-key");
    assert.equal(applyUpdate(s, { sonarr: { apiKey: "••" } }).sonarr.apiKey, "real-key", "a mangled mask is also 'unchanged'");
    assert.equal(
      applyUpdate(s, { sonarr: { url: "http://192.168.1.3:8989/", apiKey: MASK } }).sonarr.apiKey,
      "",
      "new address, old key dropped",
    );
    assert.equal(
      applyUpdate(s, { sonarr: { url: "http://192.168.1.2:8989///" } }).sonarr.apiKey,
      "real-key",
      "same address, trailing slashes ignored",
    );
  });
});

describe("network helpers", () => {
  test("home network: LAN yes; Docker 172.16/12 and loopback no (by default); IPv4-mapped IPv6 handled", () => {
    assert.equal(isHomeNetwork("192.168.1.20"), true);
    assert.equal(isHomeNetwork("10.0.0.5"), true);
    assert.equal(isHomeNetwork("::ffff:192.168.1.20"), true);
    assert.equal(isHomeNetwork("172.17.0.2"), false);
    assert.equal(isHomeNetwork("127.0.0.1"), false);
    assert.equal(isHomeNetwork("8.8.8.8"), false);
    assert.equal(isHomeNetwork("fd12::1"), true);
    assert.equal(isHomeNetwork("172.17.0.2", ["172.16.0.0/12"]), true);
    assert.equal(isHomeNetwork("192.168.1.20", ["10.0.0.0/8"]), false, "custom networks replace the defaults");
  });

  test("inCidr edge cases: /0, /32, bare address, bad input", () => {
    assert.equal(inCidr("1.2.3.4", "0.0.0.0/0"), true);
    assert.equal(inCidr("1.2.3.4", "1.2.3.4/32"), true);
    assert.equal(inCidr("1.2.3.5", "1.2.3.4/32"), false);
    assert.equal(inCidr("1.2.3.4", "1.2.3.4"), true);
    assert.equal(inCidr("not-an-ip", "10.0.0.0/8"), false);
    assert.equal(inCidr("10.0.0.1", "garbage/8"), false);
    assert.equal(inCidr("255.255.255.255", "255.255.255.0/24"), true);
  });

  test("private IPs, hosts and loopback", () => {
    for (const ip of [
      "10.1.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "127.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ])
      assert.equal(isPrivateIp(ip), true, ip);
    for (const ip of ["172.32.0.1", "172.15.0.1", "8.8.8.8", "2001:db8::1", "192.169.0.1"]) assert.equal(isPrivateIp(ip), false, ip);
    for (const h of ["localhost", "sonarr", "tower.local", "192.168.1.5", "[::1]", "my-nas"]) assert.equal(isPrivateHost(h), true, h);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "a.b.c"]) assert.equal(isPrivateHost(h), false, h);
    assert.equal(isLoopback("127.5.5.5"), true);
    assert.equal(isLoopback("::ffff:127.0.0.1"), true);
    assert.equal(isLoopback("192.168.1.1"), false);
  });
});

describe("small pure helpers", () => {
  test("eachLimit never runs more than `limit` at once, runs everything, and surfaces a failure", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await eachLimit(
      Array.from({ length: 30 }, (_, i) => i),
      4,
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        done.push(i);
        active--;
      },
    );
    assert.equal(done.length, 30);
    assert.ok(peak <= 4 && peak > 1, `peak ${peak}`);
    await eachLimit([], 4, async () => assert.fail("nothing to run"));
    await assert.rejects(
      eachLimit([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("bad item");
      }),
      /bad item/,
    );
  });

  test("episode alerts: code padding, duplicates removed, ordering, wording for 1, 2-4 and many episodes, CJK titles", () => {
    assert.equal(episodeCode({ seasonNumber: 1, episodeNumber: 5 }), "S01E05");
    assert.equal(episodeCode({ seasonNumber: 12, episodeNumber: 100 }), "S12E100");
    const one = episodeAlert("葬送のフリーレン", [{ seasonNumber: 1, episodeNumber: 5, title: 'Episode & "5"' }]);
    assert.equal(one.title, "New episode: 葬送のフリーレン");
    assert.match(one.body, /S01E05 · Episode & "5" is ready/);
    const dup = episodeAlert("X", [
      { seasonNumber: 1, episodeNumber: 2 },
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
    ]);
    assert.equal(dup.title, "2 new episodes: X");
    assert.match(dup.body, /^S01E01, S01E02 are ready/);
    const many = episodeAlert(
      "X",
      Array.from({ length: 6 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })),
    );
    assert.match(many.body, /^6 episodes \(S01E01–S01E06\)/);
  });

  test("parseId accepts positive integers only", () => {
    assert.equal(parseId("42"), 42);
    for (const bad of ["0", "-1", "1.5", "abc", "", "1e3x", " "])
      assert.throws(
        () => parseId(bad),
        (e) => e instanceof AppError && e.statusCode === 400,
        bad,
      );
  });

  test("defaultMonitor / planSeriesAdd never turn on a whole back catalogue by accident", () => {
    assert.equal(defaultMonitor(null, "all"), "future");
    assert.equal(defaultMonitor(0, "newSeason"), "future");
    assert.equal(defaultMonitor(1, "newSeason"), "all");
    assert.equal(defaultMonitor(1, "newSeason", true), "future");
    assert.equal(defaultMonitor(3, "newSeason"), "season");
    assert.equal(defaultMonitor(3, "all"), "all");
    const series = (): LibrarySeries =>
      ({ seasons: [0, 1, 2, 3].map((n) => ({ seasonNumber: n, monitored: true })) }) as unknown as LibrarySeries;
    const s = series();
    const plan = planSeriesAdd(s, 3, "season", true);
    assert.deepEqual(
      s.seasons.filter((x) => x.monitored).map((x) => x.seasonNumber),
      [3],
    );
    assert.equal(plan.listed, true);
    const unlisted = planSeriesAdd(series(), 9, "season", true);
    assert.equal(unlisted.listed, false);
    assert.deepEqual(unlisted.addOptions, { monitor: "future", searchForMissingEpisodes: false });
    assert.equal(planSeriesAdd(series(), 1, "season", true).monitor, "future", "'season' without a real sequel season falls back");
    const all = series();
    planSeriesAdd(all, null, "all", false);
    assert.deepEqual(
      all.seasons.filter((x) => x.monitored).map((x) => x.seasonNumber),
      [1, 2, 3],
      "specials (season 0) are never monitored by 'all'",
    );
    assert.equal(planSeriesAdd(series(), 2, "none", true).addOptions.searchForMissingEpisodes, false);
  });
});

describe("selectAutoAdd", () => {
  const pick = (id: number, over: Partial<ScoredPick> = {}) =>
    ({
      id,
      title: `Show ${id}`,
      match: 90,
      excluded: null,
      lowConfidence: false,
      verdict: null,
      myStatus: null,
      section: "new",
      tvdbId: id * 10,
      tvdbSeason: 1,
      inLibrary: false,
      needsMatch: false,
      matchGuessed: false,
      seasonMonitored: null,
      addVia: "sonarr",
      ...over,
    }) as unknown as ScoredPick;
  const cfg = { enabled: true, minMatch: 80, newShows: true, sequels: true, movies: true, maxPerSeason: 5, search: true };
  const run = (picks: ScoredPick[], o: Partial<Parameters<typeof selectAutoAdd>[1]> = {}) =>
    selectAutoAdd(picks, { cfg, done: new Set(), sonarrOn: true, radarrOn: true, room: 5, ...o }).map((p) => p.id);

  test("only confident, mapped, un-rated, un-seen shows qualify", () => {
    assert.deepEqual(run([pick(1)]), [1]);
    assert.deepEqual(run([pick(1, { match: 79 })]), []);
    assert.deepEqual(run([pick(1, { excluded: "x" }), pick(2, { lowConfidence: true })]), []);
    assert.deepEqual(run([pick(1, { verdict: "liked" })]), [1], "a thumbs-up is fine");
    for (const v of ["disliked", "hidden", "meh", "added", "loved"]) assert.deepEqual(run([pick(1, { verdict: v })]), [], v);
    for (const st of ["seen", "watching", "dropped", "following", "planning"] as const)
      assert.deepEqual(run([pick(1, { myStatus: st })]), [], st);
    assert.deepEqual(run([pick(1)], { done: new Set([1]) }), [], "each show at most once");
  });

  test("guessed or unmatched shows are not added blindly; the library is monitored not re-added", () => {
    assert.deepEqual(run([pick(1, { needsMatch: true }), pick(2, { matchGuessed: true }), pick(3, { tvdbId: null })]), []);
    const monitor = selectAutoAdd([pick(1, { inLibrary: true, seasonMonitored: false, tvdbSeason: 2 })], {
      cfg,
      done: new Set(),
      sonarrOn: true,
      radarrOn: true,
      room: 5,
    });
    assert.equal(monitor[0].autoAction, "monitor");
    assert.deepEqual(run([pick(1, { inLibrary: true, seasonMonitored: true, tvdbSeason: 2 })]), []);
    assert.deepEqual(run([pick(1, { inLibrary: true, seasonMonitored: false, tvdbSeason: null })]), []);
  });

  test("section switches, missing Sonarr/Radarr, and the room cap (zero or negative means none)", () => {
    assert.deepEqual(run([pick(1)], { sonarrOn: false }), []);
    assert.deepEqual(run([pick(1, { section: "continuing" })], { cfg: { ...cfg, sequels: false } }), []);
    assert.deepEqual(run([pick(1)], { cfg: { ...cfg, newShows: false } }), []);
    assert.deepEqual(run([pick(1, { section: "movies", addVia: "radarr", tvdbId: null })]), [1]);
    assert.deepEqual(run([pick(1, { section: "movies", addVia: "radarr" })], { radarrOn: false }), []);
    assert.deepEqual(run([pick(1, { section: "movies", addVia: "sonarr" })]), []);
    assert.deepEqual(run([pick(1, { section: "movies", addVia: "radarr", inLibrary: true })]), []);
    const many = [1, 2, 3, 4, 5, 6].map((i) => pick(i));
    assert.deepEqual(run(many, { room: 2 }), [1, 2]);
    assert.deepEqual(run(many, { room: 0 }), []);
    assert.deepEqual(run(many, { room: -3 }), []);
    assert.deepEqual(run([pick(1, { section: "unknown" as never })]), []);
  });
});
