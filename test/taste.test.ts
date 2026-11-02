import "./env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScoredPick, TasteProfile as Profile } from "../shared/api.js";
import { streamingLinks } from "../server/core/taste/features.js";
import { labelOf as label } from "../server/core/taste/labels.js";
import type { Media } from "../server/core/taste/media.js";
import { scoreCandidates as score, toMatch, type ScoreOptions } from "../server/core/taste/score.js";
import type { Ctx } from "../server/core/taste/types.js";
import { storeMedia as store } from "../server/data/media.js";
import { cachedMedia } from "../server/services/catalog.js";
import { tasteEnv } from "../server/services/context.js";
import { patchSettings } from "../server/services/settings.js";
import { emptyCtx, media, tags } from "./helpers.ts";

/** The engine with the app's current settings and media cache, as the picks service runs it. */
const scoreCandidates = (c: Media[], p: Profile, ctx: Ctx, opts?: ScoreOptions): ScoredPick[] => score(c, p, ctx, tasteEnv(), opts);
const labelOf = (id: number, ctx: Ctx) => label(id, ctx, cachedMedia);

const stat = (lift: number) => ({ lift, n: 20, p: 20 * lift * 0.2 });
const profile: Profile = {
  builtAt: Date.now(),
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
    "G:Sports": stat(0.3),
    "G:Slice of Life": stat(0.35),
    "T:Baseball": stat(0.2),
    "T:School": stat(0.5),
    "T:Team Sports": stat(0.3),
    "T:Iyashikei": stat(0.25),
  },
  favourites: [{ id: 9001, title: "Old Favourite", feats: ["G:Fantasy", "T:Isekai", "T:Magic", "T:Swordplay"] }],
  sources: {},
};

const fantasy = media(10, { genres: ["Fantasy", "Action"], tags: tags("Isekai", "Magic", "Swordplay", "Demons") });
const sports = media(11, { genres: ["Sports", "Slice of Life"], tags: tags("Baseball", "School", "Team Sports", "Iyashikei") });

test("a show matching what the user keeps outranks one matching what they skip", () => {
  const [f, s] = scoreCandidates([fantasy, sports], profile, emptyCtx());
  assert.ok(f.match >= s.match + 20, `${f.match} vs ${s.match}`);
  assert.ok(f.score > s.score);
  assert.deepEqual(
    f.reasons.map((r) => r.label),
    ["Isekai", "Magic", "Fantasy"],
  );
  assert.ok(s.warnings.length > 0);
  assert.equal(f.similar, "Old Favourite");
  assert.equal(f.section, "new");
  assert.equal(f.excluded, null);
  assert.equal(f.lowConfidence, false);
});

test("never-genres, kids and gore filters exclude a pick and say why", () => {
  patchSettings((x) => ({ ...x, filters: { ...x.filters, excludeGenres: ["Sports"], noGore: true } }));
  try {
    const kids = media(12, { genres: ["Comedy"], tags: tags("Kids", "School", "Magic", "Demons") });
    const gory = media(13, { genres: ["Action"], tags: tags("Gore", "Swordplay", "Demons", "Magic") });
    const [s, k, g] = scoreCandidates([sports, kids, gory], profile, emptyCtx());
    assert.equal(s.excluded, "You said never Sports");
    assert.equal(k.excluded, "Aimed at young kids");
    assert.equal(g.excluded, "Graphic violence");
  } finally {
    patchSettings((x) => ({ ...x, filters: { ...x.filters, excludeGenres: [], noGore: false } }));
  }
});

test("the user's own verdicts win: a thumbs-down is excluded and sinks; a heart lifts", () => {
  const ctx = emptyCtx({
    fb: new Map([
      [10, "disliked"],
      [11, "loved"],
    ]),
  });
  const [f, s] = scoreCandidates([fantasy, sports], profile, ctx);
  assert.equal(f.excluded, "You marked this \u{1F44E}");
  assert.equal(f.verdict, "disliked");
  assert.ok(f.match < 10);
  const [, sBase] = scoreCandidates([fantasy, sports], profile, emptyCtx());
  assert.ok(s.score > sBase.score);
});

test("a direct sequel of a show the user loved is a continuing pick of at least 90%", () => {
  const first = media(20, {
    title: { romaji: "Hero Saga", english: "Hero Saga", native: null },
    status: "FINISHED",
    genres: ["Sports"],
    tags: tags("Baseball"),
  });
  const second = media(21, {
    title: { romaji: "Hero Saga 2", english: "Hero Saga Season 2", native: null },
    genres: ["Sports"],
    tags: tags("Baseball", "School", "Team Sports", "Iyashikei"),
    relations: { edges: [{ relationType: "PREQUEL", node: { id: 20, type: "ANIME", format: "TV" } }] },
  });
  store([first], null, null); // the prequel must be in the media cache
  const [p] = scoreCandidates([second], profile, emptyCtx({ fb: new Map([[20, "loved"]]) }));
  assert.equal(p.section, "continuing");
  assert.ok(p.match >= 90, String(p.match));
  assert.deepEqual(p.continues, { title: "Hero Saga", watched: true, kept: true, behind: 0 });
  const [blind] = scoreCandidates([second], profile, emptyCtx());
  assert.ok(blind.match < 50, "without the history it's just a sports show");
});

test("labels: explicit signals win over library data", () => {
  const ctx = emptyCtx({
    byAnilist: new Map([[30, { tvdbId: 3000, season: 1 }]]),
    dropped: new Set([3000]),
    fb: new Map([
      [31, "liked"],
      [32, "meh"],
    ]),
    lists: new Map([
      [33, { status: "COMPLETED", score: 90, progress: 12 }],
      [34, { status: "DROPPED", score: null, progress: 1 }],
    ]),
    listScored: true,
  });
  assert.deepEqual(labelOf(30, ctx), { n: 1.5, p: 0.2, fav: false, known: true });
  assert.equal(labelOf(31, ctx).p, 2);
  assert.equal(labelOf(32, ctx).p, 0.3);
  assert.ok(labelOf(33, ctx).p >= 2 && labelOf(33, ctx).fav);
  assert.equal(labelOf(34, ctx).p, 0);
  assert.deepEqual(labelOf(35, ctx), { n: 1, p: 0, fav: false, known: false });
});

test("toMatch is a monotonic 0-100 scale", () => {
  let prev = -1;
  for (let s = -5; s <= 15; s += 0.5) {
    const m = toMatch(s);
    assert.ok(m >= prev && m >= 0 && m <= 100);
    prev = m;
  }
});

test("streaming links: one per service, web links only", () => {
  const m = media(40, {
    externalLinks: [
      { site: "Amazon Prime Video", url: "https://www.amazon.com/x", type: "STREAMING" },
      { site: "Prime Video", url: "https://www.primevideo.com/x", type: "STREAMING" },
      { site: "Crunchyroll", url: "javascript:alert(1)", type: "STREAMING" },
      { site: "Netflix", url: "https://www.netflix.com/title/1", type: "STREAMING" },
      { site: "Twitter", url: "https://twitter.com/x", type: "SOCIAL" },
    ],
  });
  assert.deepEqual(streamingLinks(m), [
    { site: "Prime Video", url: "https://www.amazon.com/x" },
    { site: "Netflix", url: "https://www.netflix.com/title/1" },
  ]);
});
