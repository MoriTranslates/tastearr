import type { FeatureStat, TasteProfile } from "../../../shared/api.js";
import { eligible, features, isShort, QUIET_TAGS, title } from "./features.js";
import { labelOf } from "./labels.js";
import { seasonIdx, type Media, type Season } from "./media.js";
import type { Ctx, TasteEnv } from "./types.js";

/**
 * Taste model. For every genre, tag and source type: how much more often than average the user keeps shows
 * that have it ("lift"). Training data is the last N seasons as aired, plus anything the user rated, listed on
 * AniList/MAL, or watched. Labels are per TVDB season where possible. Franchises are down-weighted so a
 * six-season show doesn't dominate, and direct sequels of shows the user watched get a strong boost at
 * recommendation time (the single best predictor in offline tests; see `npm run eval`).
 */

const SMOOTH = 4;
const MIN_SUPPORT: Record<string, number> = { G: 4, T: 6, S: 6 };
// Weights below were chosen with `npm run eval` (leave-future-season-out on a real library).
/** Quiz answers count like this many shows: strong on day one, fading as real data arrives. */
const PRIOR_N = 10;

const CHAIN = new Set(["PREQUEL", "SEQUEL", "PARENT"]);

/** Connected components over prequel/sequel/parent links among the given shows. */
export function franchises(items: Map<number, Media>) {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = x; c !== r;) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const id of items.keys()) parent.set(id, id);
  for (const m of items.values())
    for (const e of m.relations?.edges ?? [])
      if (CHAIN.has(e.relationType) && items.has(e.node.id)) parent.set(find(m.id), find(e.node.id));
  const size = new Map<number, number>();
  for (const id of items.keys()) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  return { root: find, size: (id: number) => size.get(find(id)) ?? 1 };
}

/** Shows to train on besides the season line-ups: anything rated, listed (not just planned), followed or watched. */
export function extraTrainingIds(ctx: Ctx): number[] {
  const extra = new Set<number>([...ctx.fb.keys(), ...ctx.following]);
  for (const [id, e] of ctx.lists) if (e.status !== "PLANNING") extra.add(id);
  for (const [tvdb, w] of ctx.watch) if (w.watched >= 3) for (const id of ctx.byTvdb.get(tvdb) ?? []) extra.add(id);
  return [...extra];
}

/** Whether a fetched extra show may join the training set: never adult, and (in an evaluation) nothing from after `until`. */
export function acceptExtra(m: Media, until: { season: Season; year: number } | undefined) {
  if (m.isAdult) return false;
  return !(until && m.seasonYear && m.season && seasonIdx({ season: m.season, year: m.seasonYear }) >= seasonIdx(until));
}

/** Learns the profile from the training shows. `end` is the season training stops before. */
export function computeProfile(items: Map<number, Media>, ctx: Ctx, env: TasteEnv, end: { season: Season; year: number }): TasteProfile {
  const cfg = env.config;
  const tune = cfg.tune;
  const fr = franchises(items);
  // Without any library/history, "aired but not picked" says little: weigh those shows lightly so a handful of
  // quiz answers isn't drowned out by hundreds of shows the user simply never heard of.
  const unknownWeight = ctx.hasHistory ? 1 : 0.08;
  const rows = [...items.values()].map((m) => {
    const l = labelOf(m.id, ctx, env.media);
    const ago =
      m.season && m.seasonYear
        ? Math.max(0, seasonIdx(end) - seasonIdx({ season: m.season, year: m.seasonYear }) - 1)
        : cfg.training.seasons;
    const w = ((l.known ? 1 : unknownWeight) / fr.size(m.id)) * Math.max(0.3, (tune.decay ?? 0.9) ** ago);
    return { m, l, w };
  });
  const sumN = rows.reduce((a, r) => a + r.l.n * r.w, 0);
  const sumP = rows.reduce((a, r) => a + r.l.p * r.w, 0);
  const base = sumN ? sumP / sumN : 0;
  const b = base || 0.15;

  const acc = new Map<string, { n: number; p: number }>();
  for (const r of rows) {
    for (const f of new Set(features(r.m, cfg.training.minTagRank))) {
      const a = acc.get(f) ?? { n: 0, p: 0 };
      a.n += r.l.n * r.w;
      a.p += r.l.p * r.w;
      acc.set(f, a);
    }
  }
  // Quiz answers (genres "Fantasy", themes "T:Food") are pseudo-counts.
  for (const [key, pref] of Object.entries(cfg.genrePrefs)) {
    if (pref === "ok") continue;
    const f = key.includes(":") ? key : `G:${key}`;
    const a = acc.get(f) ?? { n: 0, p: 0 };
    a.n += PRIOR_N;
    a.p += PRIOR_N * b * (pref === "love" ? 2.2 : 0.15);
    acc.set(f, a);
  }
  const minScale = ctx.hasHistory ? 1 : unknownWeight * 4;
  const feats: Record<string, FeatureStat> = {};
  for (const [f, a] of acc) {
    if (a.n < (MIN_SUPPORT[f[0]] ?? 6) * minScale) continue;
    feats[f] = {
      lift: (a.p + b * SMOOTH * minScale) / (a.n + SMOOTH * minScale) / b,
      n: Math.round(a.n * 10) / 10,
      p: Math.round(a.p * 10) / 10,
    };
  }

  // One favourite per franchise: the entry they liked most.
  const favBy = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    if (!r.l.fav || !eligible(r.m, cfg.training) || isShort(r.m)) continue;
    const k = fr.root(r.m.id);
    const cur = favBy.get(k);
    if (!cur || r.l.p > cur.l.p || (r.l.p === cur.l.p && r.m.popularity > cur.m.popularity)) favBy.set(k, r);
  }

  return {
    builtAt: Date.now(),
    trainedOn: rows.length,
    positives: rows.filter((r) => r.l.p >= 1).length,
    known: rows.filter((r) => r.l.known).length,
    base,
    features: feats,
    favourites: [...favBy.values()]
      .sort((x, y) => y.l.p - x.l.p)
      .slice(0, 300)
      .map((r) => ({
        id: r.m.id,
        title: title(r.m, cfg.titleLanguage),
        feats: features(r.m, cfg.training.minTagRank).filter((f) => !QUIET_TAGS.has(f.slice(2))),
      })),
    sources: ctx.sources,
  };
}
