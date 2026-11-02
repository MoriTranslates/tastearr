import type { MyStatus, ScoredPick, Section, TasteProfile } from "../../../shared/api.js";
import { EPISODIC_FORMATS, features, GORE_TAGS, isShort, label, QUIET_TAGS, SOURCE_LABEL, streamingLinks, title } from "./features.js";
import { chose, labelOf } from "./labels.js";
import type { Media, MediaLookup } from "./media.js";
import { inferMapping, parentIds, previousSeasons, prequelIds, sourceIds } from "./sequels.js";
import type { Ctx, Label, LibrarySeries, Mapping, TasteConfig, TasteEnv } from "./types.js";

/** Scores candidate shows against a profile: one card's worth of data per show, best explained. */

export interface ScoreOptions {
  /** Offline evaluation: ignore everything the user did with the candidate itself (no leakage). */
  blind?: boolean;
  carryIds?: Set<number>;
}

type Tune = Record<string, number>;

/** The nearest earlier season the user has a clear signal for, and how many seasons back it is (0 = the direct prequel). */
interface Prequel {
  label: Label;
  media: Media;
  depth: number;
}

const isTag = (f: string) => f.startsWith("T:");
const isGenre = (f: string) => f.startsWith("G:");
const lookedUp = (m: Media | null | undefined): m is Media => !!m;

function jaccard(a: Set<string>, b: string[]) {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  return inter / (a.size + b.length - inter || 1);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** "2030-01-05", "2031-03", "2031", or null when AniList has no year. */
function formatDate(d: Media["startDate"]) {
  if (!d?.year) return null;
  const parts = [d.year, d.month, d.day].filter((x): x is number => !!x);
  return parts.map((x, i) => (i === 0 ? String(x) : String(x).padStart(2, "0"))).join("-");
}

/**
 * Score -> 0-100. Slope fitted by `npm run eval` (a = 1.2); the midpoint is set one point below the fitted
 * 50%-kept line (5.6), so 50% here means "you keep roughly 1 in 4 shows like this" and strong picks read 85-95%.
 */
export const toMatch = (score: number, tune: Tune = {}) => Math.round(100 / (1 + Math.exp(-(tune.ma ?? 1.2) * (score - (tune.mb ?? 4.6)))));

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

// ---------------------------------------------------------------------------------------------------------------
// Settings that are the same for every candidate
// ---------------------------------------------------------------------------------------------------------------

/** Genres and tags the user never wants, from the filters and the quiz ("never" answers). */
function neverLists(cfg: TasteConfig, profile: TasteProfile) {
  const kidsLift = profile.features["T:Kids"]?.lift ?? 0;
  const never = Object.entries(cfg.genrePrefs).filter(([, v]) => v === "never");
  const genres = new Set([...cfg.filters.excludeGenres, ...never.filter(([k]) => !k.includes(":")).map(([g]) => g)]);
  // Someone who likes kids' shows (lift >= 1.2) isn't shielded from them.
  const tags = new Set([
    ...cfg.filters.excludeTags.filter((t) => !(t === "Kids" && kidsLift >= 1.2)),
    ...(cfg.filters.noGore ? GORE_TAGS : []),
    ...never.filter(([k]) => k.startsWith("T:")).map(([k]) => k.slice(2)),
  ]);
  return { genres, tags };
}

/** Where a popularity falls among the candidates, 0 (least) to 1 (most); 0.5 when there is nothing to compare with. */
function popularityPercentile(candidates: Media[]) {
  const pops = candidates.map((m) => m.popularity).sort((a, b) => a - b);
  return (p: number) => (pops.length > 1 ? pops.filter((x) => x < p).length / (pops.length - 1) : 0.5);
}

// ---------------------------------------------------------------------------------------------------------------
// Franchise: prequel, parent, compilation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Walks the direct PREQUEL chain (up to 3 back) to the nearest season the user has a signal for. `chain` is every
 * entry visited, the candidate included, so "similar to" never points back into its own franchise.
 */
function findPrequel(m: Media, before: Media[], ctx: Ctx, lookup: MediaLookup, tune: Tune) {
  let pre: Prequel | null = null;
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
  return { pre, chain };
}

/** Score added for being a later season of something the user kept (more for a favourite, less the further back it is). */
function franchiseTerm(pre: Prequel | null, parentLabel: Label | null, tiny: boolean, tune: Tune) {
  if (pre) {
    const p = pre.label.p;
    let franchise = 0;
    if (p >= 1.5) franchise = tune.frHi ?? 2.5;
    else if (p >= 1) franchise = tune.frMid ?? 1.5;
    else if (p <= 0.3) franchise = tune.frLo ?? -0.5;
    if (pre.depth > 0 && franchise > 0) franchise -= 0.5 * pre.depth; // a season or more behind
    return franchise;
  }
  // A spin-off / side story of something the user follows earns a small nudge, never a sequel boost.
  return parentLabel?.known && parentLabel.p >= 1 && !tiny ? 0.5 : 0;
}

/**
 * Compilation / recap films retell a series: label them as such rather than as a spin-off.
 * AniList puts the SUMMARY edge on the original, pointing at its recap; the recap points back as PARENT.
 */
function isCompilation(m: Media, parent: Media | null) {
  if (m.format !== "MOVIE" || !parent) return false;
  const summarisedByParent = (parent.relations?.edges ?? []).some((e) => e.relationType === "SUMMARY" && e.node.id === m.id);
  return summarisedByParent || /\b(compilation|recap|recompil|re-?edit)\b/i.test(m.description ?? "");
}

// ---------------------------------------------------------------------------------------------------------------
// Taste: how well the show's features match the profile
// ---------------------------------------------------------------------------------------------------------------

/**
 * The show's features, borrowing tags when it has too few (usual before airing) from the earlier season, the parent,
 * or else the source manga/novel, which AniList has tagged for years (eval with sparse pre-air tags: recovers about
 * half the lost accuracy). Only tags travel from a source: a manga's own source ("original") or genres say nothing
 * about the anime.
 */
function featuresWithDonor(m: Media, immediate: Media | null, parent: Media | null, lookup: MediaLookup, minRank: number) {
  const own = features(m, m.status === "NOT_YET_RELEASED" ? 40 : minRank);
  const tagCount = (fs: string[]) => fs.filter(isTag).length;
  const tagged = (x: Media) => tagCount(features(x, minRank)) >= 3;
  const source = sourceIds(m)
    .map(lookup)
    .find((x): x is Media => !!x && tagged(x));
  const donor = immediate ?? parent ?? source ?? null;
  if (tagCount(own) >= 4 || !donor) return own;
  const fromSeason = donor === immediate || donor === parent;
  const borrowed = features(donor, minRank).filter((f) => (fromSeason ? !isGenre(f) : isTag(f)));
  return [...new Set([...own, ...borrowed])];
}

/** Log-lifts of the features the profile knows about: genres, and everything else (tags, source) strongest first. */
function liftsOf(feats: string[], profile: TasteProfile) {
  const known = feats.filter((f) => profile.features[f]);
  const logLift = (f: string) => Math.log(profile.features[f].lift);
  return {
    genre: known.filter(isGenre).map(logLift),
    other: known
      .filter((f) => !isGenre(f))
      .map(logLift)
      .sort((a, b) => b - a),
  };
}

/** How much the show's features match what the user keeps: the average lift, damped when few features are known. */
function tasteTerm(lifts: ReturnType<typeof liftsOf>, tune: Tune) {
  const t = lifts.other;
  const tagPart = t.length ? mean(t) * 3 + mean(t.slice(0, 4)) : 0;
  return (tune.taste ?? 0.8) * ((tune.genre ?? 0.5) * mean(lifts.genre) + tagPart) * (t.length / (t.length + 4));
}

/**
 * Popularity part of the score. Before a show airs its AniList popularity is a fraction of what it ends at (the eval
 * sees final numbers), so the absolute term gets a floor there; the within-season percentile still orders pre-air
 * shows against each other.
 */
function popularityTerm(m: Media, immediate: Media | null, percentile: (p: number) => number, tune: Tune) {
  const logPop = Math.log10(Math.max(m.popularity, (immediate?.popularity ?? 0) * 0.3, 10));
  const absolute = m.status === "NOT_YET_RELEASED" ? Math.max(logPop, tune.preAirPop ?? 4.2) : logPop;
  return (tune.pct ?? 1.2) * percentile(m.popularity) + (tune.pop ?? 0.6) * absolute;
}

/** The labelled lifts ("Isekai", 3.0) a show ranks on, from the features the profile knows. */
function liftLabels(feats: string[], profile: TasteProfile) {
  // Where a show came from ("light novel adaptation") ranks, but makes a confusing reason chip, so it isn't shown.
  return feats
    .filter((f) => profile.features[f] && !f.startsWith("S:") && !QUIET_TAGS.has(f.slice(2)))
    .map((f) => ({ label: label(f), lift: Math.round(profile.features[f].lift * 10) / 10 }));
}

/** The title of the favourite this show is most like (needs at least 35% feature overlap), if any. */
function mostSimilarFavourite(
  feats: string[],
  profile: TasteProfile,
  skip: (id: number) => boolean,
  lookup: MediaLookup,
  titleOf: (m: Media) => string,
) {
  const mine = new Set(feats.filter((f) => !QUIET_TAGS.has(f.slice(2))));
  let best = 0.35;
  let similar: string | null = null;
  for (const f of profile.favourites) {
    if (skip(f.id)) continue;
    const j = jaccard(mine, f.feats);
    if (j <= best) continue;
    best = j;
    const fm = lookup(f.id);
    similar = fm ? titleOf(fm) : f.title;
  }
  return similar;
}

// ---------------------------------------------------------------------------------------------------------------
// The user's own history with the show, and the match percentage
// ---------------------------------------------------------------------------------------------------------------

/** Where the show lives in the user's libraries: the TVDB/TMDB match and whether it is already added. */
function libraryState(m: Media, immediate: Media | null, ctx: Ctx, blind: boolean | undefined) {
  const isMovie = m.format === "MOVIE";
  // A guessed match (see inferMapping) shows up as matchGuessed; the caller remembers it for adds.
  const map: Mapping | undefined = ctx.byAnilist.get(m.id) ?? (isMovie || blind ? undefined : inferMapping(m, immediate, ctx));
  const tmdbId = isMovie ? (ctx.movieByAnilist.get(m.id) ?? null) : null;
  const imdbId = isMovie ? (ctx.imdbByAnilist.get(m.id) ?? null) : null;
  const series = !isMovie && map ? ctx.lib.get(map.tvdbId) : undefined;
  const inLibrary = isMovie ? !!(tmdbId && ctx.movies.has(tmdbId)) : !!series;
  return { isMovie, map, tmdbId, imdbId, series, inLibrary, matchGuessed: !!map && !ctx.byAnilist.has(m.id) };
}

function verdictAdjustment(verdict: string | null) {
  if (verdict === "disliked" || verdict === "hidden") return -10;
  if (verdict === "loved" || verdict === "liked" || verdict === "added") return 3;
  return 0;
}

function statusAdjustment(myStatus: MyStatus) {
  if (myStatus === "planning") return 1.5;
  if (myStatus === "dropped") return -6;
  return 0;
}

/** The 0-100 match: the logistic of the score, then the floors and ceilings that keep it consistent with the card. */
function matchPercent(o: {
  score: number;
  tune: Tune;
  pre: Prequel | null;
  tiny: boolean;
  myStatus: MyStatus;
  progress: number | null | undefined;
  /** A retelling of something already seen: an optional rewatch, one consistent modest score. */
  rewatch: boolean;
}) {
  let match = toMatch(o.score, o.tune);
  if (o.pre && o.pre.label.p >= 1.5 && o.pre.depth === 0) match = Math.max(match, 90);
  if (o.tiny) match = Math.min(match, 80);
  // Something they're already watching: the % should never contradict the "Watching" badge.
  if (o.myStatus === "watching") match = Math.max(match, (o.progress ?? 3) >= 3 ? 90 : 75);
  if (o.rewatch) match = 50;
  return match;
}

// ---------------------------------------------------------------------------------------------------------------
// Card details
// ---------------------------------------------------------------------------------------------------------------

/** The sequel line ("continues X"): only when the prequel is the same kind of thing (episodic, or this is a movie). */
function continuesLine(m: Media, immediate: Media | null, pre: Prequel | null, titleOf: (m: Media) => string) {
  if (!immediate) return null;
  const sameKind = EPISODIC_FORMATS.has(immediate.format ?? "") === EPISODIC_FORMATS.has(m.format ?? "") || m.format === "MOVIE";
  if (!sameKind) return null;
  const p = pre?.label.p ?? 0;
  return {
    // Split cours often share an English title ("Season 2 Part 2" vs "Season 2"); fall back to romaji then.
    title: titleOf(immediate) === titleOf(m) ? (immediate.title.romaji ?? titleOf(immediate)) : titleOf(immediate),
    watched: !!pre && p >= 1.5 && pre.depth === 0,
    kept: !!pre && p >= 1,
    behind: pre?.depth ?? 0,
  };
}

function sectionOf(m: Media, immediate: Media | null, carryOver: boolean, myStatus: MyStatus): Section {
  if (m.format === "MOVIE") return "movies";
  if (isShort(m)) return "shorts";
  const continuesEpisodic = prequelIds(m).length > 0 && EPISODIC_FORMATS.has(immediate?.format ?? "TV");
  return carryOver || myStatus === "watching" || continuesEpisodic ? "continuing" : "new";
}

/** The blurb for a card: spoilers hidden, markup and the "(Source: ...)" credit removed, cut to 900 characters. */
function cleanDescription(raw: string | null) {
  const text = raw
    ?.replace(/~!.*?!~/gs, "[spoiler hidden]")
    .replace(/<[^>]+>/g, "")
    .replace(/\s*\(Source:[^)]*\)\s*$/i, "")
    .trim();
  return text ? text.slice(0, 900) : null;
}

/** The title shown, and a second title when it differs from the first. */
function cardTitles(m: Media, immediate: Media | null, titleOf: (m: Media) => string) {
  const main = titleOf(m);
  const shown = immediate && titleOf(immediate) === main && m.title.romaji ? m.title.romaji : main;
  const alt = (m.title.romaji !== main ? m.title.romaji : m.title.english) ?? null;
  return { shown, altTitle: alt === main ? null : alt };
}

/**
 * Whether new episodes are monitored in Sonarr. Season unknown (a guessed match): if the series and its latest
 * season are monitored, new episodes arrive anyway.
 */
function seasonMonitored(series: LibrarySeries | undefined, map: Mapping | undefined, guessed: boolean) {
  if (!series) return null;
  if (map?.season) return series.seasons.find((x) => x.seasonNumber === map.season)?.monitored ?? false;
  if (!guessed) return null;
  return series.monitored && !!series.seasons.filter((x) => x.seasonNumber > 0).at(-1)?.monitored;
}

function addTarget(cfg: TasteConfig, isMovie: boolean, hasMovieId: boolean) {
  if (isMovie) return hasMovieId && cfg.radarrOn ? "radarr" : null;
  return cfg.sonarrOn ? "sonarr" : null;
}

/** The top reasons (strongest lifts) and warnings (weakest) shown on a card. */
function reasonsAndWarnings(byLift: { label: string; lift: number }[]) {
  return {
    reasons: byLift
      .filter((x) => x.lift >= 1.3)
      .sort((a, b) => b.lift - a.lift)
      .slice(0, 3),
    warnings: byLift
      .filter((x) => x.lift <= 0.6)
      .sort((a, b) => a.lift - b.lift)
      .slice(0, 2),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------

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
  const never = neverLists(cfg, profile);
  const percentile = popularityPercentile(candidates);

  return candidates.map((m) => {
    const before = previousSeasons(m, lookup);
    const immediate = before[0] ?? null;
    const { pre, chain } = findPrequel(m, before, ctx, lookup, tune);
    const parent = parentIds(m).map(lookup).find(lookedUp) ?? null;
    const parentLabel = parent ? labelOf(parent.id, ctx, lookup) : null;
    const parentSeen = !!parentLabel?.known && parentLabel.p >= 1;
    const tiny = isShort(m) || (m.popularity < 1000 && (m.episodes ?? 99) < 6);

    const feats = featuresWithDonor(m, immediate, parent, lookup, cfg.training.minTagRank);
    const lifts = liftsOf(feats, profile);

    const lib = libraryState(m, immediate, ctx, opts.blind);
    const myStatus = opts.blind ? null : ownStatus(m.id, m, ctx, lib.inLibrary);
    const verdict = opts.blind ? null : (ctx.fb.get(m.id) ?? null);

    const score =
      tasteTerm(lifts, tune) +
      popularityTerm(m, immediate, percentile, tune) +
      franchiseTerm(pre, parentLabel, tiny, tune) +
      verdictAdjustment(verdict) +
      statusAdjustment(myStatus);
    const compilation = isCompilation(m, parent);
    const match = matchPercent({
      score,
      tune,
      pre,
      tiny,
      myStatus,
      progress: opts.blind ? undefined : ctx.lists.get(m.id)?.progress,
      rewatch: compilation && parentSeen,
    });

    const continuing = !!pre && pre.label.p >= 1;
    const similar =
      continuing || compilation ? null : mostSimilarFavourite(feats, profile, (id) => chain.has(id) || id === parent?.id, lookup, titleOf);
    const badGenre = m.genres.find((x) => never.genres.has(x));
    const badTag = m.tags.find(
      (x) => never.tags.has(x.name) && x.rank >= (cfg.filters.noGore && GORE_TAGS.includes(x.name) ? 35 : cfg.training.minTagRank),
    );

    const carryOver = opts.carryIds?.has(m.id) ?? false;
    const continues = continuesLine(m, immediate, pre, titleOf);
    const addVia = addTarget(cfg, lib.isMovie, !!(lib.tmdbId || lib.imdbId));
    const titles = cardTitles(m, immediate, titleOf);

    return {
      id: m.id,
      title: titles.shown,
      altTitle: titles.altTitle,
      section: sectionOf(m, immediate, carryOver, myStatus),
      carryOver,
      format: m.format,
      status: m.status,
      episodes: m.episodes,
      duration: m.duration ?? null,
      studio: m.studios.nodes[0]?.name ?? null,
      source: m.source ? (SOURCE_LABEL[m.source] ?? m.source.replace(/_/g, " ").toLowerCase()) : null,
      startDate: formatDate(m.startDate),
      // AniList gives movies a placeholder "episode 1" at the release date; that's a release, not a weekly slot.
      nextAiring:
        !lib.isMovie && m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt * 1000, episode: m.nextAiringEpisode.episode } : null,
      streaming: streamingLinks(m),
      trailer: m.trailer?.site === "youtube" ? `https://youtu.be/${m.trailer.id}` : null,
      cover: m.coverImage.large,
      color: m.coverImage.color,
      siteUrl: m.siteUrl,
      description: cleanDescription(m.description),
      genres: m.genres,
      popularity: m.popularity,
      averageScore: m.averageScore,
      score,
      match,
      lowConfidence: (lifts.other.length < 4 && !pre) || (tiny && !pre),
      continues,
      // One franchise line per card: "continues" wins, then "compilation of", then "spin-off of".
      spinOffOf: !continues && !compilation && !pre && parent ? titleOf(parent) : null,
      compilationOf: compilation && parent ? { title: titleOf(parent), seen: parentSeen } : null,
      myStatus,
      ...reasonsAndWarnings(liftLabels(feats, profile)),
      similar,
      excluded: exclusion({ verdict, myStatus, continuing, badGenre, badTag }),
      tvdbId: lib.map?.tvdbId ?? null,
      tvdbSeason: lib.map?.season ?? null,
      tmdbId: lib.tmdbId,
      inLibrary: lib.inLibrary,
      seasonMonitored: seasonMonitored(lib.series, lib.map, lib.matchGuessed),
      addVia,
      cantAdd: !addVia && lib.isMovie && cfg.radarrOn ? "Not matched to a movie database yet" : null,
      needsMatch: !lib.isMovie && cfg.sonarrOn && !lib.map,
      matchGuessed: lib.matchGuessed,
      verdict,
    };
  });
}
