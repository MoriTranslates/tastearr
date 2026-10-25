import { db, droppedSet, setJob } from "./db.js";
import { cachedMedia, getMediaByIds, getSeason, seasonOf, shiftSeason, type Media, type Season } from "./anilist.js";
import { listEntries, refreshLists } from "./lists.js";
import { mappingTables, type Mapping } from "./mapping.js";
import { watchStates, type WatchState } from "./mediaserver.js";
import { radarrConfigured, radarrMovies, type RadarrMovie } from "./radarr.js";
import { getSettings } from "./settings.js";
import { seasonOwned, sonarrSeries, type SonarrSeries } from "./sonarr.js";

/**
 * Taste model. For every genre, tag and source type: how much more often than average the user keeps shows
 * that have it ("lift"). Training data is the last N seasons as aired, plus anything the user rated, listed on
 * AniList/MAL, or watched. Labels are per TVDB season where possible. Franchises are down-weighted so a
 * six-season show doesn't dominate, and sequels of shows the user watched get a strong direct boost at
 * recommendation time (the single best predictor in offline tests).
 */

export interface FeatureStat { lift: number; n: number; p: number }
export interface Profile {
  builtAt: number;
  trainedOn: number;
  positives: number;
  base: number;
  features: Record<string, FeatureStat>;
  /** Shows the user clearly enjoyed (one per franchise), for "like X" explanations. */
  favourites: { id: number; title: string; feats: string[] }[];
  sources: Record<string, string>;
}

const SMOOTH = 4;
const MIN_SUPPORT: Record<string, number> = { G: 4, T: 6, S: 6 };
const GENRE_WEIGHT = 0.5;
const PRIOR_N = 6;
/** Tags that carry a little signal but make meaningless explanations. */
const QUIET_TAGS = new Set([
  "Male Protagonist", "Female Protagonist", "Heterosexual", "Shounen", "Seinen", "Shoujo", "Josei", "Primarily Adult Cast",
  "Primarily Teen Cast", "Primarily Male Cast", "Primarily Female Cast", "Ensemble Cast", "Coming of Age", "Episodic",
]);
const CANDIDATE_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "MOVIE"]);
const SOURCE_LABEL: Record<string, string> = {
  LIGHT_NOVEL: "Light novel", MANGA: "Manga", ORIGINAL: "Original", WEB_NOVEL: "Web novel", VIDEO_GAME: "Game", NOVEL: "Novel", VISUAL_NOVEL: "Visual novel",
};

export function features(m: Media, minRank = getSettings().training.minTagRank): string[] {
  const out = m.genres.map((g) => `G:${g}`);
  for (const t of m.tags) if (t.rank >= minRank && !t.isMediaSpoiler && !t.isGeneralSpoiler) out.push(`T:${t.name}`);
  if (m.source) out.push(`S:${m.source}`);
  return out;
}

export const label = (f: string) => (f.startsWith("S:") ? `${SOURCE_LABEL[f.slice(2)] ?? f.slice(2)} adaptation` : f.slice(2));

export function title(m: Media) {
  const lang = getSettings().display.titleLanguage;
  const t = m.title;
  return (lang === "romaji" ? t.romaji : lang === "native" ? t.native : t.english) || t.english || t.romaji || t.native || `#${m.id}`;
}

function eligible(m: Media) {
  const t = getSettings().training;
  return !m.isAdult && (!m.format || t.formats.includes(m.format)) && (!m.countryOfOrigin || t.countries.includes(m.countryOfOrigin));
}

// ---------------------------------------------------------------- what we know about the user

interface Ctx {
  lib: Map<number, SonarrSeries>;
  movies: Map<number, RadarrMovie>;
  watch: Map<number, WatchState>;
  fb: Map<number, string>;
  dropped: Set<number>;
  lists: Map<number, { status: string; score: number | null; progress: number | null }>;
  byAnilist: Map<number, Mapping>;
  byTvdb: Map<number, number[]>;
  movieByAnilist: Map<number, number>;
  sources: Record<string, string>;
}

let ctxCache: { at: number; ctx: Ctx } | null = null;

async function context(force = false): Promise<Ctx> {
  if (!force && ctxCache && Date.now() - ctxCache.at < 10 * 60_000) return ctxCache.ctx;
  const s = getSettings();
  const sources: Record<string, string> = {};
  const { byAnilist, byTvdb, movieByAnilist } = await mappingTables();

  const lib = new Map<number, SonarrSeries>();
  if (s.sonarr.url && s.sonarr.apiKey) {
    try {
      for (const x of await sonarrSeries(force)) lib.set(x.tvdbId, x);
      sources.sonarr = `${lib.size} series`;
    } catch (e) {
      sources.sonarr = `error: ${(e as Error).message}`;
    }
  } else sources.sonarr = "not connected";

  const movies = new Map<number, RadarrMovie>();
  if (radarrConfigured()) {
    try {
      for (const x of await radarrMovies(force)) movies.set(x.tmdbId, x);
      sources.radarr = `${movies.size} movies`;
    } catch (e) {
      sources.radarr = `error: ${(e as Error).message}`;
    }
  }

  let watch = new Map<number, WatchState>();
  if (s.media.type !== "none" && s.media.url && s.media.token) {
    try {
      watch = await watchStates();
      sources.media = `${[...watch.values()].filter((w) => w.watched > 0).length} shows with watch history`;
    } catch (e) {
      sources.media = `error: ${(e as Error).message}`;
    }
  } else sources.media = "not connected";

  const fbRows = db.prepare("SELECT anilist_id, verdict, source FROM feedback").all() as { anilist_id: number; verdict: string; source: string }[];
  sources.feedback = `${fbRows.filter((r) => r.source === "quiz").length} quiz answers, ${fbRows.filter((r) => r.source !== "quiz").length} ratings`;

  const lists = new Map<number, { status: string; score: number | null; progress: number | null }>();
  for (const e of listEntries()) if (!lists.has(e.id) || e.source === "anilist") lists.set(e.id, e);
  if (lists.size) sources.lists = `${lists.size} AniList/MAL entries`;

  const dropped = droppedSet();
  sources.dropped = `${dropped.size} dropped shows`;
  const ctx: Ctx = { lib, movies, watch, fb: new Map(fbRows.map((r) => [r.anilist_id, r.verdict])), dropped, lists, byAnilist, byTvdb, movieByAnilist, sources };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

interface Label { n: number; p: number; fav: boolean; known: boolean }

/** What we know about the user and one AniList entry, at TVDB-season level where possible. */
function labelOf(id: number, ctx: Ctx): Label {
  let n = 1;
  let p = 0;
  let fav = false;
  let known = false;
  const map = ctx.byAnilist.get(id);
  const tvdb = map?.tvdbId;
  const season = map?.season ?? null;

  // Sonarr / Radarr: did they pick it?
  const s = tvdb ? ctx.lib.get(tvdb) : undefined;
  if (s) {
    const realSeasons = s.seasons.filter((x) => x.seasonNumber > 0).length;
    if (seasonOwned(s, season ?? (realSeasons <= 1 ? null : -1))) [p, known] = [1, true];
  }
  const tmdb = ctx.movieByAnilist.get(id);
  const mv = tmdb ? ctx.movies.get(tmdb) : undefined;
  if (mv) [p, known] = [mv.hasFile ? 1.2 : 1, true];

  // Media server: how far did they get?
  const w = tvdb ? ctx.watch.get(tvdb) : undefined;
  if (w) {
    const sw = season !== null ? w.seasons.get(season) : w.seasons.size <= 1 ? { watched: w.watched, total: w.total } : undefined;
    if (sw && sw.total > 0) {
      const frac = sw.watched / sw.total;
      if (sw.watched >= 3 || frac >= 0.5) [p, fav, known] = [Math.max(p, 1.5 + frac), frac >= 0.5, true];
      else if (sw.watched >= 1 && sw.total >= 6 && frac < 0.25) [p, known] = [Math.min(p, 0.3), true];
      else if (sw.watched === 0 && p === 1 && sw.total >= 3) p = 0.6; // owned for a while, never started
    }
    if (w.rating !== null && w.rating > 0) {
      if (w.rating >= 8) [p, fav, known] = [Math.max(p, 2.5), true, true];
      else if (w.rating <= 4) [p, fav, known] = [0.2, false, true];
    }
  }

  // AniList / MAL list
  const e = ctx.lists.get(id);
  if (e) {
    known = true;
    const sc = e.score;
    switch (e.status) {
      case "COMPLETED":
      case "REPEATING":
        if (sc !== null && sc < 50) [p, fav] = [0.3, false];
        else [p, fav] = [Math.max(p, sc === null ? 2 : sc >= 70 ? 1.5 + (sc - 50) / 40 : 1.2), sc === null || sc >= 70];
        break;
      case "CURRENT":
        p = Math.max(p, (e.progress ?? 0) >= 3 ? 1.6 : 1);
        break;
      case "PLANNING":
        if (p < 0.8) [p, n] = [0.8, 0.5];
        break;
      case "PAUSED":
        p = (e.progress ?? 0) >= 3 ? Math.max(p, 1) : 0.3;
        break;
      case "DROPPED":
        [p, n, fav] = [0, 1.5, false];
        break;
    }
  }

  // Explicit signals win.
  if (tvdb && ctx.dropped.has(tvdb)) return { n: 1.5, p: 0.2, fav: false, known: true };
  switch (ctx.fb.get(id)) {
    case "loved": return { n: 1, p: 3, fav: true, known: true };
    case "liked": return { n: 1, p: 2, fav: true, known: true };
    case "added": return { n, p: Math.max(p, 1.5), fav, known: true };
    case "meh": return { n: 1, p: 0.3, fav: false, known: true };
    case "hidden": return { n: 1, p: Math.min(p, 0.2), fav: false, known: true };
    case "disliked": return { n: 2, p: 0, fav: false, known: true };
  }
  return { n, p, fav, known };
}

// ---------------------------------------------------------------- franchises

const CHAIN = new Set(["PREQUEL", "SEQUEL", "PARENT"]);

/** Connected components over prequel/sequel/parent links among the given shows. */
function franchises(items: Map<number, Media>) {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = x; c !== r; ) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const id of items.keys()) parent.set(id, id);
  for (const m of items.values()) for (const e of m.relations?.edges ?? []) if (CHAIN.has(e.relationType) && items.has(e.node.id)) parent.set(find(m.id), find(e.node.id));
  const size = new Map<number, number>();
  for (const id of items.keys()) size.set(find(id), (size.get(find(id)) ?? 0) + 1);
  return { root: find, size: (id: number) => size.get(find(id)) ?? 1 };
}

// ---------------------------------------------------------------- profile

export async function buildProfile(): Promise<Profile> {
  setJob("profile", "running", "Reading your library");
  try {
    const s = getSettings();
    try {
      await refreshLists();
    } catch (e) {
      console.warn("List import failed:", (e as Error).message);
    }
    const ctx = await context(true);

    const now = seasonOf();
    const items = new Map<number, Media>();
    for (let i = 1; i <= s.training.seasons; i++) {
      const { season, year } = shiftSeason(now, -i);
      setJob("profile", "running", `Downloading ${season.toLowerCase()} ${year} from AniList (${i}/${s.training.seasons})`);
      for (const m of await getSeason(season, year)) if (eligible(m)) items.set(m.id, m);
    }
    // Plus anything rated, listed, or watched from before the window.
    const extra = new Set<number>(ctx.fb.keys());
    for (const [id, e] of ctx.lists) if (e.status !== "PLANNING") extra.add(id);
    for (const [tvdb, w] of ctx.watch) if (w.watched >= 3) for (const id of ctx.byTvdb.get(tvdb) ?? []) extra.add(id);
    setJob("profile", "running", "Fetching shows you've rated or watched");
    for (const m of await getMediaByIds([...extra].filter((id) => !items.has(id)).slice(0, 1200))) if (!m.isAdult) items.set(m.id, m);

    setJob("profile", "running", "Scoring genres and tags");
    const fr = franchises(items);
    const rows = [...items.values()].map((m) => ({ m, l: labelOf(m.id, ctx), w: 1 / fr.size(m.id) }));
    const sumN = rows.reduce((a, r) => a + r.l.n * r.w, 0);
    const sumP = rows.reduce((a, r) => a + r.l.p * r.w, 0);
    const base = sumN ? sumP / sumN : 0;
    const b = base || 0.15;

    const acc = new Map<string, { n: number; p: number }>();
    for (const r of rows) {
      for (const f of new Set(features(r.m))) {
        const a = acc.get(f) ?? { n: 0, p: 0 };
        a.n += r.l.n * r.w;
        a.p += r.l.p * r.w;
        acc.set(f, a);
      }
    }
    // Quiz genre answers are pseudo-counts: they matter for new users and fade as real data arrives.
    for (const [g, pref] of Object.entries(s.genrePrefs)) {
      if (pref === "ok") continue;
      const a = acc.get(`G:${g}`) ?? { n: 0, p: 0 };
      a.n += PRIOR_N;
      a.p += PRIOR_N * b * (pref === "love" ? 1.8 : 0.2);
      acc.set(`G:${g}`, a);
    }

    const feats: Record<string, FeatureStat> = {};
    for (const [f, a] of acc) {
      if (a.n < (MIN_SUPPORT[f[0]] ?? 6)) continue;
      feats[f] = { lift: (a.p + b * SMOOTH) / (a.n + SMOOTH) / b, n: Math.round(a.n * 10) / 10, p: Math.round(a.p * 10) / 10 };
    }

    // One favourite per franchise: the entry they liked most.
    const favBy = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      if (!r.l.fav || !eligible(r.m) || r.m.format === "TV_SHORT") continue;
      const k = fr.root(r.m.id);
      const cur = favBy.get(k);
      if (!cur || r.l.p > cur.l.p || (r.l.p === cur.l.p && r.m.popularity > cur.m.popularity)) favBy.set(k, r);
    }

    const profile: Profile = {
      builtAt: Date.now(),
      trainedOn: rows.length,
      positives: rows.filter((r) => r.l.p >= 1).length,
      base,
      features: feats,
      favourites: [...favBy.values()]
        .sort((x, y) => y.l.p - x.l.p)
        .slice(0, 300)
        .map((r) => ({ id: r.m.id, title: title(r.m), feats: features(r.m).filter((f) => !QUIET_TAGS.has(f.slice(2))) })),
      sources: ctx.sources,
    };
    db.prepare("INSERT INTO settings (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(profile));
    setJob("profile", "done", `Learned from ${rows.length} shows`);
    return profile;
  } catch (e) {
    setJob("profile", "error", (e as Error).message);
    throw e;
  }
}

export function storedProfile(): Profile | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'profile'").get() as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
}

let building: Promise<Profile> | null = null;

export function rebuildProfile() {
  building ??= buildProfile().finally(() => (building = null));
  return building;
}

export async function getProfile(maxAgeMs = 86_400_000): Promise<Profile> {
  const p = storedProfile();
  if (p && Date.now() - p.builtAt < maxAgeMs) return p;
  return rebuildProfile();
}

// ---------------------------------------------------------------- recommendations

export type Section = "continuing" | "new" | "shorts" | "movies";

export interface Pick {
  id: number;
  title: string;
  altTitle: string | null;
  section: Section;
  carryOver: boolean;
  format: string | null;
  status: string | null;
  episodes: number | null;
  studio: string | null;
  source: string | null;
  startDate: string | null;
  nextAiring: { at: number; episode: number } | null;
  streaming: { site: string; url: string }[];
  trailer: string | null;
  cover: string | null;
  color: string | null;
  siteUrl: string;
  description: string | null;
  genres: string[];
  popularity: number;
  averageScore: number | null;
  score: number;
  match: number;
  lowConfidence: boolean;
  continues: { title: string; watched: boolean } | null;
  reasons: { label: string; lift: number }[];
  warnings: { label: string; lift: number }[];
  similar: string | null;
  excluded: string | null;
  tvdbId: number | null;
  tvdbSeason: number | null;
  tmdbId: number | null;
  inLibrary: boolean;
  seasonMonitored: boolean | null;
  /** "sonarr" | "radarr" when it can be added, otherwise why not. */
  addVia: "sonarr" | "radarr" | null;
  cantAdd: string | null;
  verdict: string | null;
}

const PREQUEL_EDGES = new Set(["PREQUEL", "PARENT"]);
const prequelIds = (m: Media) => (m.relations?.edges ?? []).filter((e) => PREQUEL_EDGES.has(e.relationType) && e.node.type === "ANIME").map((e) => e.node.id);

function jaccard(a: Set<string>, b: string[]) {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  return inter / (a.size + b.length - inter || 1);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtDate = (d: Media["startDate"]) =>
  d?.year ? [d.year, d.month, d.day].filter((x): x is number => !!x).map((x, i) => (i ? String(x).padStart(2, "0") : String(x))).join("-") : null;

export async function recommend(season: Season, year: number, refresh = false): Promise<{ picks: Pick[]; profileBuiltAt: number }> {
  const s = getSettings();
  const prev = shiftSeason({ season, year }, -1);
  const [list, prevList, profile, ctx] = await Promise.all([getSeason(season, year, refresh), getSeason(prev.season, prev.year), getProfile(), context(refresh)]);
  const countries = new Set(s.training.countries);
  const ok = (m: Media) => !m.isAdult && !!m.format && CANDIDATE_FORMATS.has(m.format) && (!m.countryOfOrigin || countries.has(m.countryOfOrigin));

  // Carry-overs: still airing from last season and something the user follows.
  const ids = new Set(list.map((m) => m.id));
  const carry = prevList.filter((m) => ok(m) && m.status === "RELEASING" && !ids.has(m.id) && labelOf(m.id, ctx).p >= 1);
  const carryIds = new Set(carry.map((m) => m.id));
  // AniList pages can repeat a show when popularity shifts mid-pagination.
  const candidates = [...new Map([...list.filter(ok), ...carry].map((m) => [m.id, m])).values()];

  // Prefetch two levels of prequels so sequels can inherit labels, titles and tags.
  const m1 = await getMediaByIds([...new Set(candidates.flatMap(prequelIds))]).catch(() => [] as Media[]);
  await getMediaByIds([...new Set(m1.flatMap(prequelIds))]).catch(() => [] as Media[]);

  const neverGenres = new Set([...s.filters.excludeGenres, ...Object.entries(s.genrePrefs).filter(([, v]) => v === "never").map(([g]) => g)]);
  const excludeTags = new Set(s.filters.excludeTags);
  const pops = candidates.map((m) => m.popularity).sort((a, b) => a - b);
  const pct = (p: number) => (pops.length > 1 ? pops.filter((x) => x < p).length / (pops.length - 1) : 0.5);

  const picks: Pick[] = candidates.map((m) => {
    // Nearest labelled prequel, up to 3 hops back.
    let pre: { label: Label; media: Media | null } | null = null;
    let frontier = prequelIds(m);
    const chain = new Set<number>([m.id]);
    for (let depth = 0; depth < 3 && frontier.length && !pre; depth++) {
      for (const id of frontier) {
        if (chain.has(id)) continue;
        chain.add(id);
        const l = labelOf(id, ctx);
        if (l.known && (!pre || l.p > pre.label.p)) pre = { label: l, media: cachedMedia(id) };
      }
      frontier = frontier.flatMap((id) => {
        const pm = cachedMedia(id);
        return pm ? prequelIds(pm) : [];
      });
    }
    const preMedia = pre?.media ?? prequelIds(m).map(cachedMedia).find((x): x is Media => !!x) ?? null;

    // Features, borrowing the prequel's tags when this entry has too few (common before it airs).
    let feats = features(m, m.status === "NOT_YET_RELEASED" ? 40 : undefined);
    if (feats.filter((f) => f.startsWith("T:")).length < 4 && preMedia) feats = [...new Set([...feats, ...features(preMedia).filter((f) => !f.startsWith("G:"))])];
    const g = feats.filter((f) => f.startsWith("G:") && profile.features[f]).map((f) => Math.log(profile.features[f].lift));
    const t = feats.filter((f) => !f.startsWith("G:") && profile.features[f]).map((f) => Math.log(profile.features[f].lift)).sort((a, b) => b - a);
    const taste = (GENRE_WEIGHT * mean(g) + (t.length ? mean(t) * 3 + mean(t.slice(0, 4)) : 0)) * (t.length / (t.length + 4));

    const pl = pre?.label;
    const franchise = !pl ? 0 : pl.p >= 1.5 ? 2.5 : pl.p >= 1 ? 1.5 : pl.p <= 0.3 ? -2 : 0;
    const verdict = ctx.fb.get(m.id) ?? null;
    const verdictAdj = verdict === "disliked" || verdict === "hidden" ? -10 : verdict === "loved" || verdict === "liked" || verdict === "added" ? 5 : 0;
    const popTerm = 0.6 * pct(m.popularity) + 0.35 * Math.log10(Math.max(m.popularity, (preMedia?.popularity ?? 0) * 0.3, 10));
    const score = taste + popTerm + franchise + verdictAdj;
    let match = Math.round(100 / (1 + Math.exp(-2.2 * (taste + franchise * 0.6 - 0.9))));
    if (pl && pl.p >= 1.5) match = Math.max(match, 90);

    const byLift = feats.filter((f) => profile.features[f] && !QUIET_TAGS.has(f.slice(2))).map((f) => ({ label: label(f), lift: Math.round(profile.features[f].lift * 10) / 10 }));

    const continuing = !!pl && pl.p >= 1;
    let similar: string | null = null;
    if (!continuing) {
      const mine = new Set(feats.filter((f) => !QUIET_TAGS.has(f.slice(2))));
      let bestJ = 0.35;
      for (const f of profile.favourites) {
        if (chain.has(f.id)) continue;
        const j = jaccard(mine, f.feats);
        if (j > bestJ) [bestJ, similar] = [j, f.title];
      }
    }

    const badGenre = m.genres.find((x) => neverGenres.has(x));
    const badTag = m.tags.find((x) => x.rank >= s.training.minTagRank && excludeTags.has(x.name));
    const excluded =
      verdict === "disliked" ? "You marked this 👎" : verdict === "hidden" ? "Hidden" : continuing ? null : badGenre ? `Genre: ${badGenre}` : badTag ? `Tag: ${badTag.name}` : null;

    const map = ctx.byAnilist.get(m.id);
    const isMovie = m.format === "MOVIE";
    const tmdbId = isMovie ? (ctx.movieByAnilist.get(m.id) ?? null) : null;
    const inLib = !isMovie && map ? ctx.lib.get(map.tvdbId) : undefined;
    const inLibrary = isMovie ? !!(tmdbId && ctx.movies.has(tmdbId)) : !!inLib;
    const addVia = isMovie ? (tmdbId && radarrConfigured() ? "radarr" : null) : map && s.sonarr.url ? "sonarr" : null;
    const cantAdd = addVia ? null : isMovie ? (tmdbId ? "Connect Radarr to add movies" : "No TMDB match yet") : map ? "Connect Sonarr to add shows" : "No TVDB match yet";
    const section: Section = isMovie ? "movies" : m.format === "TV_SHORT" ? "shorts" : carryIds.has(m.id) || prequelIds(m).length ? "continuing" : "new";

    return {
      id: m.id,
      title: title(m),
      altTitle: (m.title.romaji !== title(m) ? m.title.romaji : m.title.english) ?? null,
      section,
      carryOver: carryIds.has(m.id),
      format: m.format,
      status: m.status,
      episodes: m.episodes,
      studio: m.studios.nodes[0]?.name ?? null,
      source: m.source ? (SOURCE_LABEL[m.source] ?? m.source.replace(/_/g, " ").toLowerCase()) : null,
      startDate: fmtDate(m.startDate),
      nextAiring: m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt * 1000, episode: m.nextAiringEpisode.episode } : null,
      streaming: (m.externalLinks ?? []).filter((l) => l.type === "STREAMING").map((l) => ({ site: l.site, url: l.url })),
      trailer: m.trailer?.site === "youtube" ? `https://youtu.be/${m.trailer.id}` : null,
      cover: m.coverImage.large,
      color: m.coverImage.color,
      siteUrl: m.siteUrl,
      description: m.description?.replace(/<[^>]+>/g, "").replace(/\s*\(Source:[^)]*\)\s*$/i, "").trim().slice(0, 900) ?? null,
      genres: m.genres,
      popularity: m.popularity,
      averageScore: m.averageScore,
      score,
      match,
      lowConfidence: t.length < 4 && !continuing,
      continues: pl && pre?.media ? { title: title(pre.media), watched: pl.p >= 1.5 } : null,
      reasons: byLift.filter((x) => x.lift >= 1.3).sort((a, b) => b.lift - a.lift).slice(0, 3),
      warnings: byLift.filter((x) => x.lift <= 0.6).sort((a, b) => a.lift - b.lift).slice(0, 2),
      similar,
      excluded,
      tvdbId: map?.tvdbId ?? null,
      tvdbSeason: map?.season ?? null,
      tmdbId,
      inLibrary,
      seasonMonitored: inLib && map?.season ? (inLib.seasons.find((x) => x.seasonNumber === map.season)?.monitored ?? false) : null,
      addVia,
      cantAdd,
      verdict,
    };
  });
  picks.sort((a, b) => b.score - a.score);
  return { picks, profileBuiltAt: profile.builtAt };
}

export function setFeedback(id: number, verdict: string | null, source = "picks") {
  if (!verdict) db.prepare("DELETE FROM feedback WHERE anilist_id = ?").run(id);
  else
    db.prepare("INSERT INTO feedback (anilist_id, verdict, source, at) VALUES (?, ?, ?, ?) ON CONFLICT(anilist_id) DO UPDATE SET verdict = excluded.verdict, source = excluded.source, at = excluded.at").run(
      id,
      verdict,
      source,
      Date.now(),
    );
  if (ctxCache) ctxCache.ctx.fb = new Map((db.prepare("SELECT anilist_id, verdict FROM feedback").all() as { anilist_id: number; verdict: string }[]).map((r) => [r.anilist_id, r.verdict]));
}

export function invalidateContext() {
  ctxCache = null;
}
