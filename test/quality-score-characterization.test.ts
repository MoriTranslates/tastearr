import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import type { TasteProfile } from "../shared/api.js";
import type { Media } from "../server/core/taste/media.js";
import { scoreCandidates, type ScoreOptions } from "../server/core/taste/score.js";
import type { TasteConfig, TasteEnv } from "../server/core/taste/types.js";
import { emptyCtx, media, tags } from "./helpers.ts";

/**
 * Characterization test for scoreCandidates: a wide fixture of situations, with the full output of every pick stored
 * in test/fixtures/quality-score.snap.json. Refactoring the engine must not change a single field. To accept an
 * intended change, run with UPDATE_SNAP=1 and review the diff of the snapshot file.
 */

const stat = (lift: number) => ({ lift, n: 20, p: 20 * lift * 0.2 });
const profile: TasteProfile = {
  builtAt: 0,
  trainedOn: 400,
  positives: 80,
  known: 120,
  base: 0.2,
  features: {
    "G:Fantasy": stat(2.2),
    "G:Action": stat(1.6),
    "T:Isekai": stat(3),
    "T:Magic": stat(2.4),
    "T:Swordplay": stat(2),
    "T:Demons": stat(1.8),
    "S:Light Novel": stat(1.5),
    "G:Sports": stat(0.3),
    "G:Slice of Life": stat(0.35),
    "T:Baseball": stat(0.2),
    "T:School": stat(0.5),
    "T:Kids": stat(0.4),
  },
  favourites: [{ id: 9001, title: "Old Favourite", feats: ["G:Fantasy", "T:Isekai", "T:Magic", "T:Swordplay"] }],
  sources: {},
};

const config: TasteConfig = {
  training: { seasons: 8, minTagRank: 60, formats: ["TV"], countries: ["JP"] },
  filters: { excludeGenres: ["Horror"], excludeTags: ["Kids"], noGore: true },
  genrePrefs: { Romance: "never", "T:Food": "never" },
  titleLanguage: "english",
  sonarrOn: true,
  radarrOn: true,
  tune: {},
};

const pool = new Map<number, Media>();
const add = (m: Media) => {
  pool.set(m.id, m);
  return m;
};
const rel = (relationType: string, id: number, type = "ANIME", format: string | null = "TV") => ({
  relationType,
  node: { id, type, format },
});
const edges = (...e: ReturnType<typeof rel>[]) => ({ edges: e });
const T = (name: string, english = name) => ({ romaji: name, english, native: null });
const series = (id: number, tvdbId: number, title: string, seasons: { seasonNumber: number; monitored: boolean }[], over = {}) => ({
  id,
  tvdbId,
  title,
  seriesType: "anime",
  status: "continuing",
  monitored: true,
  seasons,
  ...over,
});

const fantasy = (id: number, over: Partial<Media> = {}) =>
  add(media(id, { genres: ["Fantasy", "Action"], tags: tags("Isekai", "Magic", "Swordplay", "Demons"), ...over }));

// Prequel chain: 100 <- 101 <- 102 <- 103 (candidate)
add(media(100, { title: T("Chain One"), status: "FINISHED", genres: ["Fantasy"], tags: tags("Magic") }));
add(media(101, { title: T("Chain Two"), status: "FINISHED", relations: edges(rel("PREQUEL", 100)) }));
add(media(102, { title: T("Chain Three"), status: "FINISHED", relations: edges(rel("PREQUEL", 101)) }));
const chain4 = add(media(103, { title: T("Chain Four"), relations: edges(rel("PREQUEL", 102)), genres: ["Fantasy"], tags: tags("Magic") }));
const direct = add(media(111, { title: T("Direct Two"), relations: edges(rel("PREQUEL", 110)) }));
add(media(110, { title: T("Direct One"), status: "FINISHED", genres: ["Action"], tags: tags("Swordplay") }));
const sameTitle = add(media(113, { title: T("Same"), relations: edges(rel("PREQUEL", 112)), genres: ["Action"], tags: tags("Magic") }));
add(media(112, { title: { romaji: "Same Romaji", english: "Same", native: null }, status: "FINISHED" }));
const bad = add(media(121, { title: T("Bad Two"), relations: edges(rel("PREQUEL", 120)), genres: ["Sports"], tags: tags("Baseball") }));
add(media(120, { title: T("Bad One"), status: "FINISHED", genres: ["Sports"], tags: tags("Baseball") }));
const spin = add(
  media(131, { title: T("Side Story"), format: "ONA", relations: edges(rel("PARENT", 130)), genres: ["Fantasy"], tags: tags("Magic") }),
);
add(media(130, { title: T("Main Story"), status: "FINISHED", tags: tags("Isekai", "Magic", "Swordplay") }));
const recapMovie = add(
  media(141, {
    title: T("Recap Movie"),
    format: "MOVIE",
    relations: edges(rel("PARENT", 140, "ANIME", "TV")),
    description: "A recap of season one.",
  }),
);
add(media(140, { title: T("Recapped"), status: "FINISHED", relations: edges(rel("SUMMARY", 141, "ANIME", "MOVIE")) }));
const sparse = add(media(151, { title: T("Sparse"), tags: tags("Magic"), relations: edges(rel("ADAPTATION", 150, "MANGA", "MANGA")) }));
add(media(150, { title: T("Source Manga"), format: "MANGA", tags: tags("Isekai", "Swordplay", "Demons", "Magic") }));

interface Case {
  name: string;
  candidates: Media[];
  ctx?: Parameters<typeof emptyCtx>[0];
  opts?: ScoreOptions;
}

const cases: Case[] = [
  {
    name: "plain mix",
    candidates: [
      fantasy(10),
      add(media(11, { genres: ["Sports", "Slice of Life"], tags: tags("Baseball", "School") })),
      add(media(12, { genres: ["Comedy"], tags: tags("Kids", "School") })),
      add(media(13, { genres: ["Action"], tags: tags("Gore", "Swordplay") })),
      add(media(14, { genres: ["Horror"] })),
      add(media(15, { genres: ["Romance"], tags: tags("Food") })),
      add(media(16, { genres: ["Fantasy"], tags: tags("Food", "Magic"), popularity: 90000, status: "RELEASING", source: "LIGHT_NOVEL" })),
    ],
  },
  {
    name: "loved prequel",
    candidates: [direct, sameTitle],
    ctx: {
      fb: new Map([
        [110, "loved"],
        [112, "liked"],
      ]),
    },
  },
  { name: "chain depth", candidates: [chain4], ctx: { fb: new Map([[100, "loved"]]) } },
  { name: "chain depth two", candidates: [chain4], ctx: { fb: new Map([[101, "loved"]]) } },
  {
    name: "chosen prequel via library",
    candidates: [direct],
    ctx: { byAnilist: new Map([[110, { tvdbId: 1100, season: 1 }]]), following: new Set([110]) },
  },
  { name: "disliked prequel", candidates: [bad], ctx: { fb: new Map([[120, "disliked"]]) } },
  { name: "spin-off of followed", candidates: [spin], ctx: { fb: new Map([[130, "loved"]]) } },
  { name: "recap movie", candidates: [recapMovie], ctx: { fb: new Map([[140, "loved"]]) } },
  { name: "sparse tags borrow", candidates: [sparse] },
  {
    name: "own statuses",
    candidates: [
      fantasy(201, { status: "FINISHED" }),
      fantasy(202, { status: "RELEASING", nextAiringEpisode: { airingAt: 1_800_000_000, episode: 3 } }),
      fantasy(203),
      fantasy(204),
      fantasy(205),
      fantasy(206),
    ],
    ctx: {
      lists: new Map([
        [201, { status: "COMPLETED", score: 90, progress: 12 }],
        [202, { status: "CURRENT", score: null, progress: 1 }],
        [203, { status: "PLANNING", score: null, progress: 0 }],
        [204, { status: "REPEATING", score: 80, progress: 12 }],
      ]),
      following: new Set([205]),
      byAnilist: new Map([[206, { tvdbId: 2060, season: 1 }]]),
      dropped: new Set([2060]),
    },
  },
  {
    name: "library and sonarr mapping",
    candidates: [
      fantasy(301),
      fantasy(302),
      add(media(303, { title: T("Mapped Show"), tags: tags("Magic") })),
      fantasy(304, { format: "ONA", duration: 5, episodes: 12 }),
    ],
    ctx: {
      byAnilist: new Map([
        [301, { tvdbId: 3010, season: 2 }],
        [302, { tvdbId: 3020, season: null }],
      ]),
      lib: new Map([
        [
          3010,
          series(1, 3010, "A", [
            { seasonNumber: 1, monitored: false },
            { seasonNumber: 2, monitored: true },
          ]),
        ],
        [
          3020,
          series(2, 3020, "B", [
            { seasonNumber: 0, monitored: false },
            { seasonNumber: 1, monitored: true },
          ]),
        ],
        [3030, series(3, 3030, "Mapped Show", [{ seasonNumber: 1, monitored: true }], { year: 2030 })],
      ]),
    },
  },
  {
    name: "movies",
    candidates: [
      add(media(401, { format: "MOVIE", episodes: 1, tags: tags("Magic"), genres: ["Fantasy"] })),
      add(media(402, { format: "MOVIE", episodes: 1 })),
      add(media(403, { format: "MOVIE", episodes: 1 })),
    ],
    ctx: {
      movieByAnilist: new Map([[401, 9401]]),
      imdbByAnilist: new Map([[402, "tt0000402"]]),
      movies: new Map([[9401, { id: 1, tmdbId: 9401, title: "M", hasFile: true, monitored: true }]]),
    },
  },
  {
    name: "blind",
    candidates: [direct, fantasy(501)],
    ctx: {
      fb: new Map([
        [110, "loved"],
        [501, "disliked"],
      ]),
      lists: new Map([[501, { status: "CURRENT", score: null, progress: 5 }]]),
    },
    opts: { blind: true },
  },
  { name: "carry over", candidates: [fantasy(601), fantasy(602)], opts: { carryIds: new Set([601]) } },
  {
    name: "odd descriptions and dates",
    candidates: [
      fantasy(701, {
        description: "Hello ~!big spoiler!~ <b>world</b> (Source: Wiki)",
        startDate: { year: 2031, month: 3, day: null },
        trailer: { id: "abc", site: "youtube" },
        studios: { nodes: [{ name: "Studio X" }] },
      }),
      fantasy(702, {
        startDate: { year: null, month: null, day: null },
        source: "VIDEO_GAME",
        title: { romaji: "Romaji Only", english: null, native: null },
      }),
      fantasy(703, { popularity: 10, episodes: 3 }),
      fantasy(704, { format: "SPECIAL", duration: 4 }),
    ],
  },
];

const run = () => {
  const env: TasteEnv = { config, media: (id) => pool.get(id) ?? null };
  return Object.fromEntries(cases.map((c) => [c.name, scoreCandidates(c.candidates, profile, emptyCtx(c.ctx), env, c.opts)]));
};

const SNAP = new URL("./fixtures/quality-score.snap.json", import.meta.url);

test("scoreCandidates output is unchanged on the characterization fixture", () => {
  const actual: unknown = JSON.parse(JSON.stringify(run()));
  if (process.env.UPDATE_SNAP) fs.writeFileSync(SNAP, JSON.stringify(actual, null, 1) + "\n");
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(SNAP, "utf8")));
});

test("the characterization fixture exercises the interesting branches", () => {
  const all = Object.values(run()).flat();
  const some = (f: (p: (typeof all)[number]) => unknown) => all.some(f);
  assert.ok(some((p) => p.section === "continuing") && some((p) => p.section === "movies") && some((p) => p.section === "shorts"));
  assert.ok(some((p) => p.excluded) && some((p) => p.continues) && some((p) => p.compilationOf) && some((p) => p.spinOffOf));
  for (const s of ["watching", "planning", "seen", "dropped", "following"])
    assert.ok(
      some((p) => p.myStatus === s),
      s,
    );
  assert.ok(some((p) => p.matchGuessed) && some((p) => p.addVia === "radarr") && some((p) => p.needsMatch));
});
