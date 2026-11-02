import type { MyStatus, ScoredPick, Section, TasteProfile } from "../../../shared/api.js";
import { EPISODIC_FORMATS, features, GORE_TAGS, isShort, label, QUIET_TAGS, SOURCE_LABEL, streamingLinks, title } from "./features.js";
import { chose, labelOf } from "./labels.js";
import type { Media } from "./media.js";
import { inferMapping, parentIds, previousSeasons, prequelIds, sourceIds } from "./sequels.js";
import type { Ctx, Label, TasteEnv } from "./types.js";

/** Scores candidate shows against a profile: one card's worth of data per show, best explained. */

export interface ScoreOptions {
  /** Offline evaluation: ignore everything the user did with the candidate itself (no leakage). */
  blind?: boolean;
  carryIds?: Set<number>;
}

function jaccard(a: Set<string>, b: string[]) {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  return inter / (a.size + b.length - inter || 1);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtDate = (d: Media["startDate"]) =>
  d?.year
    ? [d.year, d.month, d.day]
        .filter((x): x is number => !!x)
        .map((x, i) => (i ? String(x).padStart(2, "0") : String(x)))
        .join("-")
    : null;

/**
 * Score -> 0-100. Slope fitted by `npm run eval` (a = 1.2); the midpoint is set one point below the fitted
 * 50%-kept line (5.6), so 50% here means "you keep roughly 1 in 4 shows like this" and strong picks read 85-95%.
 */
export const toMatch = (score: number, tune: Record<string, number> = {}) =>
  Math.round(100 / (1 + Math.exp(-(tune.ma ?? 1.2) * (score - (tune.mb ?? 4.6)))));

function ownStatus(id: number, m: Media, ctx: Ctx, inLibrary: boolean): MyStatus {
  const map = ctx.byAnilist.get(id);
  if (map && ctx.dropped.has(map.tvdbId)) return "dropped";
  const e = ctx.lists.get(id);
  if (e?.status === "COMPLETED" || e?.status === "REPEATING") return m.status === "FINISHED" || !m.nextAiringEpisode ? "seen" : "watching";
  if (e?.status === "CURRENT") return "watching";
  if (ctx.following.has(id)) return "following";
  if (inLibrary) return null;
  if (e?.status === "PLANNING") return "planning";
  return null;
}

/** Why a pick is filtered out, in the user's words; null when it isn't. */
function exclusion(o: {
  verdict: string | null;
  myStatus: MyStatus;
  continuing: boolean;
  badGenre: string | undefined;
  badTag: { name: string } | undefined;
}) {
  if (o.verdict === "disliked") return "You marked this 👎";
  if (o.verdict === "hidden") return "You hid this";
  if (o.myStatus === "seen") return "You've already seen this";
  if (o.myStatus === "dropped") return "You stopped watching this";
  if (o.continuing) return null;
  if (o.badGenre) return `You said never ${o.badGenre}`;
  if (!o.badTag) return null;
  if (o.badTag.name === "Kids") return "Aimed at young kids";
  if (GORE_TAGS.includes(o.badTag.name)) return "Graphic violence";
  return `You said never ${label(`T:${o.badTag.name}`)}`;
}

/** Scores candidate shows against a profile. Pure, so the offline evaluation can reuse it. */
export function scoreCandidates(
  candidates: Media[],
  profile: TasteProfile,
  ctx: Ctx,
  env: TasteEnv,
  opts: ScoreOptions = {},
): ScoredPick[] {
  const cfg = env.config;
  const tune = cfg.tune;
  const lookup = env.media;
  const titleOf = (x: Media) => title(x, cfg.titleLanguage);
  const kidsLift = profile.features["T:Kids"]?.lift ?? 0;
  const neverGenres = new Set([
    ...cfg.filters.excludeGenres,
    ...Object.entries(cfg.genrePrefs)
      .filter(([k, v]) => v === "never" && !k.includes(":"))
      .map(([g]) => g),
  ]);
  const excludeTags = new Set([
    ...cfg.filters.excludeTags.filter((t) => !(t === "Kids" && kidsLift >= 1.2)),
    ...(cfg.filters.noGore ? GORE_TAGS : []),
    ...Object.entries(cfg.genrePrefs)
      .filter(([k, v]) => v === "never" && k.startsWith("T:"))
      .map(([k]) => k.slice(2)),
  ]);
  const pops = candidates.map((m) => m.popularity).sort((a, b) => a - b);
  const pct = (p: number) => (pops.length > 1 ? pops.filter((x) => x < p).length / (pops.length - 1) : 0.5);

  return candidates.map((m) => {
    // Walk the direct PREQUEL chain (up to 3 back) to the nearest season the user has a signal for.
    const before = previousSeasons(m, lookup);
    const immediate = before[0] ?? null;
    let pre: { label: Label; media: Media; depth: number } | null = null;
    const chain = new Set<number>([m.id]);
    let frontier = before.map((x) => x.id);
    for (let depth = 0; depth < 3 && frontier.length && !pre; depth++) {
      const next: number[] = [];
      for (const pid of frontier) {
        if (chain.has(pid)) continue;
        chain.add(pid);
        const pm = lookup(pid);
        if (!pm) continue;
        let l = labelOf(pid, ctx, lookup);
        // Following a franchise in Sonarr/Radarr is itself the signal, even if the media server shows little watching
        // (people watch on other devices, or Plex history is incomplete): treat a chosen prequel as "kept".
        if ((tune.chosePre ?? 1) && l.p < 1 && l.p > 0.3 && chose(pid, ctx)) l = { ...l, p: 1, known: true };
        if (l.known && (l.p >= 1 || l.p <= 0.3) && (!pre || l.p > pre.label.p)) pre = { label: l, media: pm, depth };
        next.push(...previousSeasons(pm, lookup).map((x) => x.id));
      }
      frontier = next;
    }
    // A spin-off / side story of something the user follows earns a small nudge, never a sequel boost.
    const parent =
      parentIds(m)
        .map(lookup)
        .find((x): x is Media => !!x) ?? null;
    const parentLabel = parent ? labelOf(parent.id, ctx, lookup) : null;
    const tiny = isShort(m) || (m.popularity < 1000 && (m.episodes ?? 99) < 6);

    // Features, borrowing the prequel's tags when this entry has too few (common before it airs).
    const minRank = cfg.training.minTagRank;
    let feats = features(m, m.status === "NOT_YET_RELEASED" ? 40 : minRank);
    // Too few tags (usual before airing): borrow from the earlier season, the parent, or else the source manga/novel,
    // which AniList has tagged for years (eval with sparse pre-air tags: recovers about half the lost accuracy).
    const tagged = (x: Media) => features(x, minRank).filter((f) => f.startsWith("T:")).length >= 3;
    const donor =
      immediate ??
      parent ??
      sourceIds(m)
        .map(lookup)
        .find((x): x is Media => !!x && tagged(x)) ??
      null;
    // Only tags travel: a manga's own source ("original") or genres say nothing about the anime.
    if (feats.filter((f) => f.startsWith("T:")).length < 4 && donor)
      feats = [
        ...new Set([
          ...feats,
          ...features(donor, minRank).filter((f) => (donor === immediate || donor === parent ? !f.startsWith("G:") : f.startsWith("T:"))),
        ]),
      ];
    const g = feats.filter((f) => f.startsWith("G:") && profile.features[f]).map((f) => Math.log(profile.features[f].lift));
    const t = feats
      .filter((f) => !f.startsWith("G:") && profile.features[f])
      .map((f) => Math.log(profile.features[f].lift))
      .sort((a, b) => b - a);
    const genreWeight = tune.genre ?? 0.5;
    const taste =
      (tune.taste ?? 0.8) * (genreWeight * mean(g) + (t.length ? mean(t) * 3 + mean(t.slice(0, 4)) : 0)) * (t.length / (t.length + 4));

    const pl = pre?.label;
    let franchise = !pl ? 0 : pl.p >= 1.5 ? (tune.frHi ?? 2.5) : pl.p >= 1 ? (tune.frMid ?? 1.5) : pl.p <= 0.3 ? (tune.frLo ?? -0.5) : 0;
    if (pl && pre && pre.depth > 0 && franchise > 0) franchise -= 0.5 * pre.depth; // a season or more behind
    if (!pl && parentLabel?.known && parentLabel.p >= 1 && !tiny) franchise = 0.5;

    const isMovie = m.format === "MOVIE";
    // A guessed match (see inferMapping) shows up as matchGuessed; the caller remembers it for adds.
    const map = ctx.byAnilist.get(m.id) ?? (isMovie || opts.blind ? undefined : inferMapping(m, immediate, ctx));
    const tmdbId = isMovie ? (ctx.movieByAnilist.get(m.id) ?? null) : null;
    const imdbId = isMovie ? (ctx.imdbByAnilist.get(m.id) ?? null) : null;
    const inLib = !isMovie && map ? ctx.lib.get(map.tvdbId) : undefined;
    const inLibrary = isMovie ? !!(tmdbId && ctx.movies.has(tmdbId)) : !!inLib;
    const myStatus = opts.blind ? null : ownStatus(m.id, m, ctx, inLibrary);
    const verdict = opts.blind ? null : (ctx.fb.get(m.id) ?? null);

    const verdictAdj =
      verdict === "disliked" || verdict === "hidden" ? -10 : verdict === "loved" || verdict === "liked" || verdict === "added" ? 3 : 0;
    const statusAdj = myStatus === "planning" ? 1.5 : myStatus === "dropped" ? -6 : 0;
    // Before a show airs its AniList popularity is a fraction of what it ends at (the eval sees final numbers), so the
    // absolute term gets a floor there; the within-season percentile still orders pre-air shows against each other.
    const preAir = m.status === "NOT_YET_RELEASED";
    const logPop = Math.log10(Math.max(m.popularity, (immediate?.popularity ?? 0) * 0.3, 10));
    const popTerm = (tune.pct ?? 1.2) * pct(m.popularity) + (tune.pop ?? 0.6) * (preAir ? Math.max(logPop, tune.preAirPop ?? 4.2) : logPop);
    const score = taste + popTerm + franchise + verdictAdj + statusAdj;
    let match = toMatch(score, tune);
    if (pl && pl.p >= 1.5 && pre?.depth === 0) match = Math.max(match, 90);
    const lowConfidence = (t.length < 4 && !pl) || (tiny && !pl);
    if (tiny) match = Math.min(match, 80);
    // Something they're already watching: the % should never contradict the "Watching" badge.
    const listed = opts.blind ? undefined : ctx.lists.get(m.id);
    if (myStatus === "watching") match = Math.max(match, (listed?.progress ?? 3) >= 3 ? 90 : 75);
    // Compilation / recap films retell a series: label them as such rather than as a spin-off.
    // AniList puts the SUMMARY edge on the original, pointing at its recap; the recap points back as PARENT.
    const compilation =
      isMovie &&
      !!parent &&
      ((parent.relations?.edges ?? []).some((e) => e.relationType === "SUMMARY" && e.node.id === m.id) ||
        /\b(compilation|recap|recompil|re-?edit)\b/i.test(m.description ?? ""));
    // A retelling of something already seen is an optional rewatch: one consistent, modest score.
    if (compilation && parentLabel?.known && parentLabel.p >= 1) match = 50;

    // Where a show came from ("light novel adaptation") ranks, but makes a confusing reason chip, so it isn't shown.
    const byLift = feats
      .filter((f) => profile.features[f] && !f.startsWith("S:") && !QUIET_TAGS.has(f.slice(2)))
      .map((f) => ({ label: label(f), lift: Math.round(profile.features[f].lift * 10) / 10 }));

    const continuing = !!pl && pl.p >= 1;
    let similar: string | null = null;
    if (!continuing && !compilation) {
      const mine = new Set(feats.filter((f) => !QUIET_TAGS.has(f.slice(2))));
      let bestJ = 0.35;
      for (const f of profile.favourites) {
        if (chain.has(f.id) || f.id === parent?.id) continue;
        const j = jaccard(mine, f.feats);
        if (j > bestJ) {
          bestJ = j;
          const fm = lookup(f.id);
          similar = fm ? titleOf(fm) : f.title;
        }
      }
    }

    const badGenre = m.genres.find((x) => neverGenres.has(x));
    const badTag = m.tags.find(
      (x) => excludeTags.has(x.name) && x.rank >= (cfg.filters.noGore && GORE_TAGS.includes(x.name) ? 35 : cfg.training.minTagRank),
    );
    const excluded = exclusion({ verdict, myStatus, continuing, badGenre, badTag });

    const carryOver = opts.carryIds?.has(m.id) ?? false;
    const continues =
      immediate && (EPISODIC_FORMATS.has(immediate.format ?? "") === EPISODIC_FORMATS.has(m.format ?? "") || isMovie)
        ? {
            // Split cours often share an English title ("Season 2 Part 2" vs "Season 2"); fall back to romaji then.
            title: titleOf(immediate) === titleOf(m) ? (immediate.title.romaji ?? titleOf(immediate)) : titleOf(immediate),
            watched: !!pl && pl.p >= 1.5 && pre!.depth === 0,
            kept: !!pl && pl.p >= 1,
            behind: pre?.depth ?? 0,
          }
        : null;
    const hasSequelChain = prequelIds(m).length > 0;
    const section: Section = isMovie
      ? "movies"
      : isShort(m)
        ? "shorts"
        : carryOver || myStatus === "watching" || (hasSequelChain && EPISODIC_FORMATS.has(immediate?.format ?? "TV"))
          ? "continuing"
          : "new";
    const addVia = isMovie ? ((tmdbId || imdbId) && cfg.radarrOn ? "radarr" : null) : cfg.sonarrOn ? "sonarr" : null;
    const needsMatch = !isMovie && cfg.sonarrOn && !map;
    const matchGuessed = !!map && !ctx.byAnilist.has(m.id);
    const cantAdd = addVia ? null : isMovie ? (cfg.radarrOn ? "Not matched to a movie database yet" : null) : null;
    const desc = m.description
      ?.replace(/~!.*?!~/gs, "[spoiler hidden]")
      .replace(/<[^>]+>/g, "")
      .replace(/\s*\(Source:[^)]*\)\s*$/i, "")
      .trim();
    const shown = immediate && titleOf(immediate) === titleOf(m) && m.title.romaji ? m.title.romaji : titleOf(m);
    const alt = (m.title.romaji !== titleOf(m) ? m.title.romaji : m.title.english) ?? null;

    return {
      id: m.id,
      title: shown,
      altTitle: alt === titleOf(m) ? null : alt,
      section,
      carryOver,
      format: m.format,
      status: m.status,
      episodes: m.episodes,
      duration: m.duration ?? null,
      studio: m.studios.nodes[0]?.name ?? null,
      source: m.source ? (SOURCE_LABEL[m.source] ?? m.source.replace(/_/g, " ").toLowerCase()) : null,
      startDate: fmtDate(m.startDate),
      // AniList gives movies a placeholder "episode 1" at the release date; that's a release, not a weekly slot.
      nextAiring:
        !isMovie && m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt * 1000, episode: m.nextAiringEpisode.episode } : null,
      streaming: streamingLinks(m),
      trailer: m.trailer?.site === "youtube" ? `https://youtu.be/${m.trailer.id}` : null,
      cover: m.coverImage.large,
      color: m.coverImage.color,
      siteUrl: m.siteUrl,
      description: desc ? desc.slice(0, 900) : null,
      genres: m.genres,
      popularity: m.popularity,
      averageScore: m.averageScore,
      score,
      match,
      lowConfidence,
      continues,
      // One franchise line per card: "continues" wins, then "compilation of", then "spin-off of".
      spinOffOf: !continues && !compilation && !pl && parent ? titleOf(parent) : null,
      compilationOf: compilation && parent ? { title: titleOf(parent), seen: !!parentLabel?.known && parentLabel.p >= 1 } : null,
      myStatus,
      reasons: byLift
        .filter((x) => x.lift >= 1.3)
        .sort((a, b) => b.lift - a.lift)
        .slice(0, 3),
      warnings: byLift
        .filter((x) => x.lift <= 0.6)
        .sort((a, b) => a.lift - b.lift)
        .slice(0, 2),
      similar,
      excluded,
      tvdbId: map?.tvdbId ?? null,
      tvdbSeason: map?.season ?? null,
      tmdbId,
      inLibrary,
      // Season unknown (a guessed match): if the series and its latest season are monitored, new episodes arrive anyway.
      seasonMonitored:
        inLib && map?.season
          ? (inLib.seasons.find((x) => x.seasonNumber === map.season)?.monitored ?? false)
          : inLib && matchGuessed
            ? inLib.monitored && !!inLib.seasons.filter((x) => x.seasonNumber > 0).at(-1)?.monitored
            : null,
      addVia,
      cantAdd,
      needsMatch,
      matchGuessed,
      verdict,
    };
  });
}
