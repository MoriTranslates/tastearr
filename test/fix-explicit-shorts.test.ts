import "./env.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { isCandidate } from "../server/core/taste/candidates.js";
import type { Media } from "../server/core/taste/media.js";
import { seasonOf } from "../server/core/taste/media.js";
import type { TasteConfig } from "../server/core/taste/types.js";
import { autoAddCandidates } from "../server/services/autoadd.js";
import { invalidateContext } from "../server/services/context.js";
import { getSettings, patchSettings } from "../server/services/settings.js";
import { forgetSeries } from "../server/services/sonarr.js";
import { installWorld, newWorld, resetUserData, seedTaste, SONARR, writeAnimeList, type World } from "./world.ts";
import { media } from "./helpers.ts";

/**
 * "Skip explicit shorts". The user likes ecchi and fan service but not shows that actually show sex. Those are
 * typically shorts (6-12 min, AniList TV_SHORT) tagged Ecchi with a very high Nudity rank, and they are not isAdult.
 * Full-length ecchi must NOT be filtered. Shapes below mirror the cached AniList rows (Fall 2026).
 */

const tag = (name: string, rank: number) => ({ name, rank, isGeneralSpoiler: false, isMediaSpoiler: false });
const cfg = (skip: boolean): TasteConfig => ({
  training: { seasons: 8, minTagRank: 60, formats: ["TV", "TV_SHORT", "ONA"], countries: ["JP"] },
  filters: { excludeGenres: [], excludeTags: [], noGore: false, skipExplicitShorts: skip },
  genrePrefs: {},
  titleLanguage: "english",
  sonarrOn: true,
  radarrOn: false,
  tune: {},
});

const girlfriendsFriend = (): Media =>
  media(1, { format: "TV_SHORT", duration: 12, genres: ["Drama", "Ecchi", "Romance"], tags: [tag("Heterosexual", 94), tag("Nudity", 90)] });
const darkSummoner = (): Media =>
  media(2, {
    format: "TV_SHORT",
    duration: 12,
    genres: ["Comedy", "Ecchi", "Fantasy", "Romance"],
    tags: [tag("Heterosexual", 100), tag("Nudity", 92), tag("Hypersexuality", 55)],
  });
const mouseCursor = (): Media =>
  media(3, {
    format: "TV_SHORT",
    duration: 6,
    genres: ["Ecchi", "Romance", "Supernatural"],
    tags: [tag("Nudity", 80), tag("Public Sex", 20)],
  });
const magicalExplorer = (): Media =>
  media(4, { format: "ONA", duration: 24, genres: ["Action", "Adventure", "Ecchi", "Fantasy", "Romance"], tags: [tag("Nudity", 71)] });
const studentCouncil = (): Media =>
  media(5, { format: "TV", duration: 24, genres: ["Comedy", "Ecchi", "Slice of Life"], tags: [tag("Nudity", 82)] });

describe("skip explicit shorts: which shows are filtered", () => {
  test("the three dropped shows' shapes are not candidates", () => {
    for (const m of [girlfriendsFriend(), darkSummoner(), mouseCursor()]) assert.equal(isCandidate(m, cfg(true)), false, String(m.id));
  });

  test("full-length ecchi with high Nudity is still a candidate", () => {
    assert.equal(isCandidate(magicalExplorer(), cfg(true)), true);
    assert.equal(isCandidate(studentCouncil(), cfg(true)), true);
  });

  test("a short without Ecchi is kept, even with a high Nudity tag", () => {
    assert.equal(
      isCandidate(media(6, { format: "TV_SHORT", duration: 10, genres: ["Comedy"], tags: [tag("Nudity", 95)] }), cfg(true)),
      true,
    );
  });

  test("a short with Ecchi but a low Nudity rank is kept (fan service, not explicit)", () => {
    assert.equal(
      isCandidate(media(7, { format: "TV_SHORT", duration: 10, genres: ["Ecchi"], tags: [tag("Nudity", 74)] }), cfg(true)),
      true,
    );
    assert.equal(isCandidate(media(8, { format: "TV_SHORT", duration: 10, genres: ["Ecchi"], tags: [] }), cfg(true)), true);
  });

  test("the Nudity rank of exactly 75 and a length of exactly 15 minutes are filtered; 16 minutes is not", () => {
    const edge = (duration: number, rank: number) => media(9, { format: "TV", duration, genres: ["Ecchi"], tags: [tag("Nudity", rank)] });
    assert.equal(isCandidate(edge(15, 75), cfg(true)), false);
    assert.equal(isCandidate(edge(16, 75), cfg(true)), true);
  });

  test("unknown duration falls back to the format: TV_SHORT is a short, TV is not", () => {
    const base = { duration: null, genres: ["Ecchi"], tags: [tag("Nudity", 90)] };
    assert.equal(isCandidate(media(10, { ...base, format: "TV_SHORT" }), cfg(true)), false);
    assert.equal(isCandidate(media(11, { ...base, format: "TV" }), cfg(true)), true);
  });

  test("a movie is never a short", () => {
    assert.equal(isCandidate(media(12, { format: "MOVIE", duration: 12, genres: ["Ecchi"], tags: [tag("Nudity", 90)] }), cfg(true)), true);
  });

  test("with the setting off, all of them go through", () => {
    for (const m of [girlfriendsFriend(), darkSummoner(), mouseCursor()]) assert.equal(isCandidate(m, cfg(false)), true, String(m.id));
  });

  test("the setting is on by default", () => {
    assert.equal(getSettings().filters.skipExplicitShorts, true);
  });
});

describe("skip explicit shorts: auto-add", () => {
  let w: World;
  let net: ReturnType<typeof installWorld>;
  const cur = seasonOf();

  beforeEach(() => {
    resetUserData();
    w = newWorld();
    net = installWorld(w);
    const fresh = seedTaste(w, 2);
    // An explicit short in this season, shaped like the fantasy picks so it would otherwise score well.
    const explicit = {
      ...darkSummoner(),
      id: 999,
      season: cur.season,
      seasonYear: cur.year,
      tags: [...fresh[0]!.tags, ...darkSummoner().tags],
    };
    w.seasons.get(`${cur.season}-${cur.year}`)!.push(explicit);
    w.byId.set(999, explicit);
    const all = [...fresh, explicit];
    writeAnimeList(all.map((m, i) => ({ anilist_id: m.id, tvdb_id: 5000 + i, season: { tvdb: 1 } })));
    all.forEach((m, i) =>
      w.sonarrLookup.set(5000 + i, {
        title: `Show ${m.id}`,
        tvdbId: 5000 + i,
        year: 2026,
        seasons: [{ seasonNumber: 1, monitored: false }],
      }),
    );
    patchSettings((s) => ({
      ...s,
      sonarr: { ...s.sonarr, url: SONARR, apiKey: "k", qualityProfileId: 4, rootFolderPath: "/tv" },
      lists: { anilistUser: "adam", malUser: "", malClientId: "" },
      training: { ...s.training, seasons: 1 },
      autoAdd: { ...s.autoAdd, enabled: true, minMatch: 1, newShows: true, search: false },
    }));
    invalidateContext();
    forgetSeries();
  });
  afterEach(() => net.restore());

  test("an explicit short is never an auto-add candidate; with the setting off it is", async () => {
    const ids = async () => (await autoAddCandidates(cur.season, cur.year)).map((p) => p.id);
    assert.ok(!(await ids()).includes(999));
    assert.ok((await ids()).includes(300), "ordinary picks are still added");
    patchSettings((s) => ({ ...s, filters: { ...s.filters, skipExplicitShorts: false } }));
    invalidateContext();
    assert.ok((await ids()).includes(999));
  });
});
