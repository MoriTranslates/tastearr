import "./env.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { monitorOptions, rateTitleMatch } from "../server/core/add-plan.js";
import { chose, choseWithFiles, labelOf, seasonOwned } from "../server/core/taste/labels.js";
import type { Media } from "../server/core/taste/media.js";
import { inferMapping, isSplitCour, parentIds, previousSeasons, prequelIds, sourceIds } from "../server/core/taste/sequels.js";
import type { Ctx, LibrarySeries, WatchState } from "../server/core/taste/types.js";
import { emptyCtx, media } from "./helpers.ts";

/** How the engine reads what the user did (library, watching, lists, verdicts) and how it walks franchises. */

const series = (tvdbId: number, seasons: { n: number; monitored?: boolean; files?: number }[], over: Record<string, unknown> = {}) =>
  ({
    id: tvdbId,
    tvdbId,
    title: `Series ${tvdbId}`,
    seriesType: "anime",
    monitored: true,
    seasons: seasons.map((s) => ({ seasonNumber: s.n, monitored: s.monitored ?? false, statistics: { episodeFileCount: s.files ?? 0 } })),
    ...over,
  }) as unknown as LibrarySeries;
const watch = (watched: number, total: number, seasons: [number, number, number][] = [], rating: number | null = null): WatchState => ({
  title: "x",
  watched,
  total,
  seasons: new Map(seasons.map(([n, w, t]) => [n, { watched: w, total: t }])),
  rating,
});
const ctxWith = (over: Partial<Ctx>) => emptyCtx({ byAnilist: new Map([[1, { tvdbId: 100, season: 1 }]]), ...over });
const none = () => null;

describe("labelOf", () => {
  test("nothing known: neutral weight, no signal", () => {
    assert.deepEqual(labelOf(1, emptyCtx(), none), { n: 1, p: 0, fav: false, known: false });
  });

  test("a season monitored or downloaded in Sonarr counts as kept; one Sonarr doesn't list does not", () => {
    const lib = new Map([[100, series(100, [{ n: 1, monitored: true }, { n: 2 }])]]);
    assert.equal(labelOf(1, ctxWith({ lib }), none).p, 1);
    assert.equal(labelOf(1, ctxWith({ lib, byAnilist: new Map([[1, { tvdbId: 100, season: 3 }]]) }), none).known, false);
    assert.equal(
      labelOf(1, ctxWith({ lib, byAnilist: new Map([[1, { tvdbId: 100, season: 2 }]]) }), none).known,
      false,
      "listed but not wanted",
    );
    const files = new Map([[100, series(100, [{ n: 1, files: 12 }])]]);
    assert.equal(labelOf(1, ctxWith({ lib: files }), none).p, 1);
  });

  test("watch progress: finished, barely started, and unwatched-but-downloaded", () => {
    const lib = new Map([[100, series(100, [{ n: 1, monitored: true, files: 12 }])]]);
    const finished = labelOf(1, ctxWith({ lib, watch: new Map([[100, watch(12, 12, [[1, 12, 12]])]]) }), none);
    assert.ok(finished.p >= 2.5 && finished.fav, JSON.stringify(finished));
    const dropped = labelOf(1, ctxWith({ lib, watch: new Map([[100, watch(1, 12, [[1, 1, 12]])]]) }), none);
    assert.equal(dropped.p, 0.3);
    const untouched = labelOf(1, ctxWith({ lib, watch: new Map([[100, watch(0, 0)]]) }), none);
    assert.equal(untouched.p, 1, "recent shows just have not been watched yet");
  });

  test("a media-server rating of 8+ is a favourite, 4 or less is a clear no", () => {
    const w = (r: number) => ctxWith({ watch: new Map([[100, watch(1, 12, [[1, 1, 12]], r)]]) });
    assert.deepEqual([labelOf(1, w(9), none).fav, labelOf(1, w(9), none).p], [true, 2.5]);
    assert.equal(labelOf(1, w(3), none).p, 0.2);
  });

  test("list statuses: completed with score, low score, current, planning, paused, dropped (scored and unscored lists)", () => {
    const entry = (status: string, score: number | null, progress: number | null) => ({
      id: 1,
      source: "anilist",
      status,
      score,
      progress,
    });
    const run = (e: ReturnType<typeof entry>, over: Partial<Ctx> = {}) =>
      labelOf(1, emptyCtx({ lists: new Map([[1, e]]), ...over }), (id) => (id === 1 ? media(1, { episodes: 12 }) : null));
    assert.deepEqual([run(entry("COMPLETED", 90, 12)).p > 1.5, run(entry("COMPLETED", 90, 12)).fav], [true, true]);
    assert.equal(run(entry("COMPLETED", 40, 12)).p, 0.3);
    assert.equal(run(entry("COMPLETED", null, 12)).p, 2);
    assert.equal(run(entry("CURRENT", null, 5)).p, 1.6);
    assert.deepEqual([run(entry("PLANNING", null, 0)).p, run(entry("PLANNING", null, 0)).n], [0.8, 0.5]);
    assert.equal(run(entry("PAUSED", null, 1)).p, 0);
    assert.equal(run(entry("PAUSED", null, 5)).p, 1);
    assert.equal(run(entry("DROPPED", 60, 11)).p, 1.8, "nearly finished then marked dropped: probably a sync glitch");
    assert.equal(run(entry("DROPPED", 60, 1), { listScored: true }).p, 0);
    assert.equal(run(entry("DROPPED", null, 1), { listScored: false }).p, 0.3);
    assert.equal(run(entry("DROPPED", null, 5)).n, 0.5);
    assert.equal(run(entry("MYSTERY", null, 5)).known, true);
  });

  test("explicit verdicts win over everything, and a dropped series wins over a verdict", () => {
    const run = (v: string, over: Partial<Ctx> = {}) => labelOf(1, ctxWith({ fb: new Map([[1, v]]), ...over }), none);
    assert.equal(run("loved").p, 3);
    assert.equal(run("liked").p, 2);
    assert.equal(run("meh").p, 0.3);
    assert.equal(run("disliked").p, 0);
    assert.equal(run("hidden").p, 0);
    assert.equal(run("added").p, 1.5);
    assert.deepEqual(run("loved", { dropped: new Set([100]) }), { n: 1.5, p: 0.2, fav: false, known: true });
    assert.equal(labelOf(1, ctxWith({ following: new Set([1]) }), none).p, 1.5);
  });

  test("movies: in Radarr counts, with a file counts a little more", () => {
    const base = { movieByAnilist: new Map([[1, 55]]) };
    assert.equal(labelOf(1, emptyCtx({ ...base, movies: new Map([[55, { tmdbId: 55, hasFile: false }]]) as never }), none).p, 1);
    assert.equal(labelOf(1, emptyCtx({ ...base, movies: new Map([[55, { tmdbId: 55, hasFile: true }]]) as never }), none).p, 1.2);
  });
});

describe("chose / seasonOwned", () => {
  test("seasonOwned handles unknown seasons, whole-series checks and file counts", () => {
    const s = series(1, [{ n: 0, monitored: true }, { n: 1 }, { n: 2, files: 3 }]);
    assert.equal(seasonOwned(s, 1), false);
    assert.equal(seasonOwned(s, 2), true);
    assert.equal(seasonOwned(s, 9), null);
    assert.equal(seasonOwned(s, null), true, "specials alone never count, but season 2 has files");
    assert.equal(seasonOwned(series(1, [{ n: 0, monitored: true }]), null), false);
  });

  test("chose: an unmapped season of a multi-season series is not 'chosen'; choseWithFiles needs files", () => {
    const lib = new Map([
      [
        100,
        series(100, [
          { n: 1, monitored: true },
          { n: 2, monitored: true },
        ]),
      ],
    ]);
    assert.equal(chose(1, ctxWith({ lib, byAnilist: new Map([[1, { tvdbId: 100, season: null }]]) })), false);
    assert.equal(chose(1, ctxWith({ lib })), true);
    assert.equal(choseWithFiles(1, ctxWith({ lib })), false);
    assert.equal(choseWithFiles(1, ctxWith({ lib: new Map([[100, series(100, [{ n: 1, files: 2 }])]]) })), true);
    assert.equal(chose(9, emptyCtx()), false);
    const movies = new Map([[55, { tmdbId: 55, hasFile: true }]]) as never;
    assert.equal(chose(1, emptyCtx({ movieByAnilist: new Map([[1, 55]]), movies })), true);
    assert.equal(choseWithFiles(1, emptyCtx({ movieByAnilist: new Map([[1, 55]]), movies })), true);
  });
});

describe("franchise walking", () => {
  const rel = (relationType: string, id: number, type = "ANIME", format = "TV") => ({ relationType, node: { id, type, format } });
  const m = (id: number, format: string, edges: ReturnType<typeof rel>[] = [], over: Partial<Media> = {}) =>
    media(id, { format, relations: { edges } as never, ...over });
  const lookupOf =
    (...list: Media[]) =>
    (id: number) =>
      list.find((x) => x.id === id) ?? null;

  test("prequel, parent and source ids only take the right relation and media type", () => {
    const x = m(1, "TV", [
      rel("PREQUEL", 2),
      rel("PREQUEL", 3, "MANGA"),
      rel("PARENT", 4),
      rel("SEQUEL", 5),
      rel("ADAPTATION", 6, "MANGA"),
      rel("SOURCE", 7, "MANGA"),
      rel("ALTERNATIVE", 8, "MANGA"),
    ]);
    assert.deepEqual(prequelIds(x), [2]);
    assert.deepEqual(parentIds(x), [4]);
    assert.deepEqual(sourceIds(x), [7, 6, 8], "SOURCE before ADAPTATION before ALTERNATIVE");
    assert.deepEqual(prequelIds(media(9, { relations: undefined as never })), []);
  });

  test("previousSeasons puts TV before a movie, looks through a recap special, ignores music and survives cycles", () => {
    const s1 = m(10, "TV");
    const recap = m(11, "SPECIAL", [rel("PREQUEL", 10)]);
    const movie = m(12, "MOVIE");
    const song = m(13, "MUSIC");
    const s2 = m(20, "TV", [rel("PREQUEL", 12), rel("PREQUEL", 11), rel("PREQUEL", 13)]);
    const out = previousSeasons(s2, lookupOf(s1, recap, movie, song, s2));
    assert.deepEqual(
      out.map((x) => x.id),
      [10, 12],
    );
    const a = m(30, "TV", [rel("PREQUEL", 31)]);
    const b = m(31, "OVA", [rel("PREQUEL", 30)]);
    assert.doesNotThrow(() => previousSeasons(a, lookupOf(a, b)));
    assert.deepEqual(previousSeasons(m(40, "TV", [rel("PREQUEL", 999)]), lookupOf()), [], "an unfetched prequel is simply absent");
  });

  test("split cours are recognised in either title", () => {
    assert.equal(isSplitCour({ title: { english: "Show Part 2", romaji: null } }), true);
    assert.equal(isSplitCour({ title: { english: null, romaji: "Show 2nd Cour" } }), true);
    assert.equal(isSplitCour({ title: { english: "Show Part II", romaji: "x" } }), true);
    assert.equal(isSplitCour({ title: { english: "Show 2", romaji: "Show Season 2" } }), false);
  });

  test("inferMapping: same title already in Sonarr; next season after a mapped previous one; claimed or split seasons stay unknown", () => {
    const lib = new Map([
      [100, series(100, [{ n: 1, monitored: true }, { n: 2 }], { title: "Cool Show", year: 2023 })],
      [300, series(300, [{ n: 1 }], { title: "Brand New!", year: 2026 })],
    ]);
    const byAnilist = new Map([[1, { tvdbId: 100, season: 1 }]]);
    const byTvdb = new Map([[100, [1]]]);
    const ctx = emptyCtx({ lib, byAnilist, byTvdb });
    const prev = m(1, "TV");
    const next = m(2, "TV", [], { title: { romaji: "Cool Show 2", english: "Cool Show 2", native: null } });
    assert.deepEqual(inferMapping(next, prev, ctx), { tvdbId: 100, season: 2 });
    const split = m(2, "TV", [], { title: { romaji: "Cool Show Part 2", english: null, native: null } });
    assert.deepEqual(inferMapping(split, prev, ctx), { tvdbId: 100, season: null });
    const claimed = emptyCtx({
      lib,
      byAnilist: new Map([...byAnilist, [9, { tvdbId: 100, season: 2 }]]),
      byTvdb: new Map([[100, [1, 9]]]),
    });
    assert.deepEqual(inferMapping(next, prev, claimed), { tvdbId: 100, season: null });
    const brandNew = m(3, "TV", [], {
      title: { romaji: "Brand New", english: "Brand New!", native: null },
      startDate: { year: 2026, month: 10, day: 1 },
    });
    assert.deepEqual(inferMapping(brandNew, null, ctx), { tvdbId: 300, season: 1 }, "matched by title alone");
    assert.equal(inferMapping(m(4, "MOVIE"), prev, ctx), undefined, "movies are never guessed");
    assert.equal(inferMapping(next, null, ctx), undefined);
    assert.equal(inferMapping(next, m(5, "MOVIE"), ctx), undefined);
    const tooOld = m(6, "TV", [], {
      title: { romaji: "Brand New", english: "Brand New!", native: null },
      startDate: { year: 2015, month: 1, day: 1 },
    });
    assert.equal(inferMapping(tooOld, null, ctx), undefined, "a same-named series from years earlier is a different show");
  });
});

describe("add-plan helpers", () => {
  test("monitorOptions offers 'season only' just for real sequel seasons", () => {
    assert.deepEqual(
      monitorOptions(3).map((o) => o.value),
      ["season", "all", "future", "none"],
    );
    assert.deepEqual(
      monitorOptions(1).map((o) => o.value),
      ["all", "future", "none"],
    );
    assert.deepEqual(
      monitorOptions(null).map((o) => o.value),
      ["all", "future", "none"],
    );
  });

  test("rateTitleMatch: close titles are confident; unrelated ones are not; owned and plausible-year shows rank higher", () => {
    const x = (title: string, year: number, tvdbId = 1) =>
      ({ tvdbId, title, year, seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }], overview: "o".repeat(500) }) as unknown as LibrarySeries;
    const titles = ["Frieren: Beyond Journey's End", "Sousou no Frieren", "葬送のフリーレン"];
    const good = rateTitleMatch(x("Frieren Beyond Journeys End", 2023), titles, 2023, new Set());
    assert.equal(good.confident, true);
    assert.deepEqual(good.seasons, [1]);
    assert.equal(good.overview!.length, 200);
    const bad = rateTitleMatch(x("Dark Blue Sea", 2023, 2), titles, 2023, new Set());
    assert.equal(bad.confident, false);
    assert.ok(good.rank > bad.rank);
    const owned = rateTitleMatch(x("Frieren Beyond Journeys End", 2023), titles, 2023, new Set([1]));
    assert.equal(owned.inLibrary, true);
    assert.ok(owned.rank > good.rank);
    const later = rateTitleMatch(x("Frieren Beyond Journeys End", 2030), titles, 2023, new Set());
    assert.ok(later.rank < good.rank, "a series cannot start after the show it is matched to");
    assert.doesNotThrow(() => rateTitleMatch(x("", 2023), [], null, new Set()));
  });
});
