import { db, droppedSet, setJob } from "./db.js";
import { cachedMedia, getMediaByIds, getSeason, seasonOf, shiftSeason, SEASONS, type Media, type Season } from "./anilist.js";
import { listEntries, refreshLists } from "./lists.js";
import { mappingTables, setInferred, type Mapping } from "./mapping.js";
import { watchStates, type WatchState } from "./mediaserver.js";
import { radarrConfigured, radarrMovies, type RadarrMovie } from "./radarr.js";
import { getSettings } from "./settings.js";
import { seasonOwned, sonarrSeries, type SonarrSeries } from "./sonarr.js";

/**
 * Taste model. For every genre, tag and source type: how much more often than average the user keeps shows
 * that have it ("lift"). Training data is the last N seasons as aired, plus anything the user rated, listed on
 * AniList/MAL, or watched. Labels are per TVDB season where possible. Franchises are down-weighted so a
 * six-season show doesn't dominate, and direct sequels of shows the user watched get a strong boost at
 * recommendation time (the single best predictor in offline tests; see `npm run eval`).
 */

export interface FeatureStat { lift: number; n: number; p: number }
export interface Profile {
  builtAt: number;
  trainedOn: number;
  positives: number;
  /** Shows with a real signal from the user (library, watch, list, rating), as opposed to "aired, didn't pick". */
  known: number;
  base: number;
  features: Record<string, FeatureStat>;
  /** Shows the user clearly enjoyed (one per franchise), for "like X" explanations. */
  favourites: { id: number; title: string; feats: string[] }[];
  sources: Record<string, string>;
}

/** Dev-only knob for `npm run eval` experiments, e.g. TASTEARR_TUNE='{"pop":0.5}'. */
const TUNE: Record<string, number> = (() => {
  try {
    return JSON.parse(process.env.TASTEARR_TUNE ?? "{}");
  } catch {
    return {};
  }
})();
const SMOOTH = 4;
const MIN_SUPPORT: Record<string, number> = { G: 4, T: 6, S: 6 };
const GENRE_WEIGHT = TUNE.genre ?? 0.5;
// Weights below were chosen with `npm run eval` (leave-future-season-out on a real library).
/** Quiz answers count like this many shows: strong on day one, fading as real data arrives. */
const PRIOR_N = 10;
/** Tags that carry a little signal but make meaningless explanations. */
export const QUIET_TAGS = new Set([
  "Male Protagonist", "Female Protagonist", "Heterosexual", "Shounen", "Seinen", "Shoujo", "Josei", "Primarily Adult Cast",
  "Primarily Teen Cast", "Primarily Male Cast", "Primarily Female Cast", "Ensemble Cast", "Coming of Age", "Episodic",
  "Primarily Child Cast", "Primarily Animal Cast", "Full CGI", "Chibi", "Kemonomimi", "Kuudere", "Tsundere", "Nudity", "Gore",
  // Real signal, but "you usually skip disability" reads badly as an explanation.
  "Disability", "LGBTQ+ Themes", "Mental Illness", "Suicide", "Bullying", "Slavery", "Assassins", "Curses",
]);
/** Plain names for AniList tags that read oddly on a card (the quiz uses the same words). */
const TAG_LABEL: Record<string, string> = {
  "Female Harem": "Harem", "Male Harem": "Reverse harem", "Cute Girls Doing Cute Things": "Cute & cozy", Iyashikei: "Relaxing",
  "Video Games": "Video-game world", "Urban Fantasy": "Modern-day fantasy", "Super Power": "Superpowers", Swordplay: "Sword fights",
};
export const GORE_TAGS = ["Gore", "Body Horror", "Torture", "Cannibalism"];
const CANDIDATE_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "MOVIE"]);
const EPISODIC_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const SOURCE_LABEL: Record<string, string> = {
  LIGHT_NOVEL: "Light novel", MANGA: "Manga", ORIGINAL: "Original story", WEB_NOVEL: "Web novel", VIDEO_GAME: "Video game", NOVEL: "Novel", VISUAL_NOVEL: "Visual novel",
};
/** One name per streaming service, so filters and chips don't split "Amazon Prime Video" from "Prime Video". */
const SERVICE_ALIASES: Record<string, string> = {
  "Amazon Prime Video": "Prime Video", Amazon: "Prime Video", "Amazon Video": "Prime Video", "Disney Plus": "Disney+", "Hulu Japan": "Hulu",
  "HIDIVE": "HIDIVE", "Hidive": "HIDIVE", "Bilibili": "Bilibili TV", "iQ": "iQIYI", "iQiyi": "iQIYI",
};

export function features(m: Media, minRank = getSettings().training.minTagRank): string[] {
  const out = m.genres.map((g) => `G:${g}`);
  for (const t of m.tags) if (t.rank >= minRank && !t.isMediaSpoiler && !t.isGeneralSpoiler) out.push(`T:${t.name}`);
  if (m.source) out.push(`S:${m.source}`);
  return out;
}

export const label = (f: string) =>
  f.startsWith("S:") ? `${SOURCE_LABEL[f.slice(2)] ?? f.slice(2).replace(/_/g, " ").toLowerCase()} adaptation` : (TAG_LABEL[f.slice(2)] ?? f.slice(2));

export function title(m: Media) {
  const lang = getSettings().display.titleLanguage;
  const t = m.title;
  return (lang === "romaji" ? t.romaji : lang === "native" ? t.native : t.english) || t.english || t.romaji || t.native || `#${m.id}`;
}

function eligible(m: Media) {
  const t = getSettings().training;
  return !m.isAdult && (!m.format || t.formats.includes(m.format)) && (!m.countryOfOrigin || t.countries.includes(m.countryOfOrigin));
}

// 12-minute half-length series are real shows (and often ecchi/comedy favourites) even when AniList files them as
// TV_SHORT; only true minis are "shorts". Episode length decides when it's known, the format otherwise.
const isShort = (m: Media) => m.format !== "MOVIE" && (m.duration ? m.duration <= 9 : m.format === "TV_SHORT");

// ---------------------------------------------------------------- what we know about the user

interface ListEntry { status: string; score: number | null; progress: number | null }

export interface Ctx {
  lib: Map<number, SonarrSeries>;
  movies: Map<number, RadarrMovie>;
  watch: Map<number, WatchState>;
  fb: Map<number, string>;
  dropped: Set<number>;
  lists: Map<number, ListEntry>;
  /** True when the list has scores; an unscored list that's mostly DROPPED is probably an automated sync. */
  listScored: boolean;
  following: Set<number>;
  byAnilist: Map<number, Mapping>;
  byTvdb: Map<number, number[]>;
  movieByAnilist: Map<number, number>;
  imdbByAnilist: Map<number, string>;
  /** The user has a library or history to learn from (not quiz-only). */
  hasHistory: boolean;
  sources: Record<string, string>;
}

let ctxCache: { at: number; ctx: Ctx } | null = null;

export async function context(force = false): Promise<Ctx> {
  if (!force && ctxCache && Date.now() - ctxCache.at < 10 * 60_000) return ctxCache.ctx;
  const s = getSettings();
  const sources: Record<string, string> = {};
  const { byAnilist, byTvdb, movieByAnilist, imdbByAnilist } = await mappingTables();

  const lib = new Map<number, SonarrSeries>();
  if (s.sonarr.url && s.sonarr.apiKey) {
    try {
      for (const x of await sonarrSeries(force)) lib.set(x.tvdbId, x);
      sources.sonarr = `${lib.size} series`;
    } catch (e) {
      sources.sonarr = `error: ${(e as Error).message}`;
    }
  }

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
  }

  const fbRows = db.prepare("SELECT anilist_id, verdict, source FROM feedback").all() as { anilist_id: number; verdict: string; source: string }[];
  const quiz = fbRows.filter((r) => r.source === "quiz").length;
  if (quiz || fbRows.length) sources.ratings = `${quiz} quiz answers, ${fbRows.length - quiz} ratings`;

  const lists = new Map<number, ListEntry>();
  for (const e of listEntries()) if (!lists.has(e.id) || e.source === "anilist") lists.set(e.id, e);
  const listScored = [...lists.values()].some((e) => e.score !== null && e.score > 0);
  if (lists.size) sources.lists = `${lists.size} AniList/MAL entries${listScored ? "" : " (no scores)"}`;

  const dropped = droppedSet();
  if (dropped.size) sources.dropped = `${dropped.size} shows you're not into`;
  const following = new Set((db.prepare("SELECT anilist_id FROM following").all() as { anilist_id: number }[]).map((r) => r.anilist_id));
  const ctx: Ctx = {
    lib,
    movies,
    watch,
    fb: new Map(fbRows.map((r) => [r.anilist_id, r.verdict])),
    dropped,
    lists,
    listScored,
    following,
    byAnilist,
    byTvdb,
    movieByAnilist,
    imdbByAnilist,
    hasHistory: lib.size > 0 || movies.size > 0 || watch.size > 0 || lists.size > 0,
    sources,
  };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

/** Watch progress from the media server, cached with the context (My Shows reuses it instead of rescanning Plex). */
export async function cachedWatch() {
  return (await context()).watch;
}

interface Label { n: number; p: number; fav: boolean; known: boolean }

/** Finished airing more than about two seasons ago. */
function finishedLongAgo(m: Media | null) {
  if (!m || m.status !== "FINISHED" || !m.seasonYear || !m.season) return false;
  return seasonIdx(seasonOf()) - seasonIdx({ season: m.season, year: m.seasonYear }) >= 2;
}

/** The user chose this exact entry: its TVDB season is monitored or downloaded in Sonarr, or the movie is in Radarr. */
export function chose(id: number, ctx: Ctx) {
  const map = ctx.byAnilist.get(id);
  const s = map ? ctx.lib.get(map.tvdbId) : undefined;
  if (s) {
    const real = s.seasons.filter((x) => x.seasonNumber > 0).length;
    if (seasonOwned(s, map!.season ?? (real <= 1 ? null : -1))) return true;
  }
  const tmdb = ctx.movieByAnilist.get(id);
  return !!(tmdb && ctx.movies.has(tmdb));
}

/** Like chose(), but only when the season has files: Sonarr auto-monitors new seasons of owned series. */
export function choseWithFiles(id: number, ctx: Ctx) {
  const map = ctx.byAnilist.get(id);
  const s = map ? ctx.lib.get(map.tvdbId) : undefined;
  if (s) {
    const seasons = map!.season !== null ? s.seasons.filter((x) => x.seasonNumber === map!.season) : s.seasons.filter((x) => x.seasonNumber > 0);
    if (seasons.some((x) => (x.statistics?.episodeFileCount ?? 0) > 0)) return true;
  }
  const tmdb = ctx.movieByAnilist.get(id);
  return !!(tmdb && ctx.movies.get(tmdb)?.hasFile);
}

/** What we know about the user and one AniList entry, at TVDB-season level where possible. */
export function labelOf(id: number, ctx: Ctx): Label {
  let n = 1;
  let p = 0;
  let fav = false;
  let known = false;
  const map = ctx.byAnilist.get(id);
  const tvdb = map?.tvdbId;
  const season = map?.season ?? null;
  const media = cachedMedia(id);

  // Sonarr / Radarr: did they pick it?
  const s = tvdb ? ctx.lib.get(tvdb) : undefined;
  let seasonFiles = 0;
  if (s) {
    const realSeasons = s.seasons.filter((x) => x.seasonNumber > 0).length;
    if (seasonOwned(s, season ?? (realSeasons <= 1 ? null : -1))) [p, known] = [1, true];
    seasonFiles = (season !== null ? s.seasons.find((x) => x.seasonNumber === season)?.statistics?.episodeFileCount : undefined) ?? 0;
  }
  const tmdb = ctx.movieByAnilist.get(id);
  const mv = tmdb ? ctx.movies.get(tmdb) : undefined;
  if (mv) [p, known] = [mv.hasFile ? 1.2 : 1, true];

  // Media server: how far did they get? (Plex/Jellyfin are the most reliable signal.)
  let watchKnown = false;
  const w = tvdb ? ctx.watch.get(tvdb) : undefined;
  if (w) {
    let sw = season !== null ? w.seasons.get(season) : w.seasons.size <= 1 ? { watched: w.watched, total: w.total } : undefined;
    // Nothing watched in the whole series: per-season detail isn't fetched, so use Sonarr's file count for the season.
    if (!sw && w.watched === 0 && seasonFiles > 0) sw = { watched: 0, total: seasonFiles };
    if (sw && sw.total > 0) {
      const frac = sw.watched / sw.total;
      if (sw.watched >= 3 || frac >= 0.5) [p, fav, known, watchKnown] = [Math.max(p, 1.5 + frac), frac >= 0.5, true, true];
      else if (sw.watched >= 1 && sw.total >= 6 && frac < 0.25) [p, known, watchKnown] = [Math.min(p, 0.3), true, true];
      // Downloaded but never started, long after it finished airing: lukewarm. Recent shows just haven't been watched yet.
      else if (sw.watched === 0 && p === 1 && sw.total >= 3 && finishedLongAgo(media)) p = 0.6;
    }
    if (w.rating !== null && w.rating > 0) {
      if (w.rating >= 8) [p, fav, known, watchKnown] = [Math.max(p, 2.5), true, true, true];
      else if (w.rating <= 4) [p, fav, known, watchKnown] = [0.2, false, true, true];
    }
  }

  // AniList / MAL list. An unscored list is treated as weaker evidence, and never overrides what Plex saw.
  const e = ctx.lists.get(id);
  if (e && !watchKnown) {
    known = true;
    const sc = e.score && e.score > 0 ? e.score : null;
    const eps = media?.episodes ?? null;
    const frac = e.progress && eps ? e.progress / eps : 0;
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
        p = (e.progress ?? 0) >= 3 ? Math.max(p, 1) : Math.max(Math.min(p, 0.3), p >= 1 ? p : 0);
        break;
      case "DROPPED":
        // Sync tools often mark nearly-finished shows "dropped" when the last episode wasn't scrobbled.
        if (frac >= 0.75) [p, fav] = [Math.max(p, 1.8), true];
        else if ((e.progress ?? 0) >= 3) [p, n] = [Math.max(p, 1), 0.5];
        else if (p < 1) [p, n] = [ctx.listScored ? 0 : 0.3, ctx.listScored ? 1.5 : 1];
        break;
    }
  }

  // Explicit signals win.
  if (tvdb && ctx.dropped.has(tvdb)) return { n: 1.5, p: 0.2, fav: false, known: true };
  if (ctx.following.has(id)) [p, known] = [Math.max(p, 1.5), true];
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

const seasonIdx = (s: { season: Season; year: number }) => s.year * 4 + SEASONS.indexOf(s.season);

/**
 * Builds the taste profile. `until` limits training to seasons before it (used by the offline evaluation),
 * and `save: false` keeps it out of the database.
 */
export async function buildProfile(opts: { until?: { season: Season; year: number }; save?: boolean; ctx?: Ctx } = {}): Promise<Profile> {
  const save = opts.save !== false;
  if (save) setJob("profile", "running", "Reading your library");
  try {
    const s = getSettings();
    if (save) {
      try {
        await refreshLists();
      } catch (e) {
        console.warn("List import failed:", (e as Error).message);
      }
    }
    const ctx = opts.ctx ?? (await context(true));
    const end = opts.until ?? seasonOf();

    const items = new Map<number, Media>();
    for (let i = 1; i <= s.training.seasons; i++) {
      const { season, year } = shiftSeason(end, -i);
      if (save) setJob("profile", "running", `Downloading ${season.toLowerCase()} ${year} from AniList (${i}/${s.training.seasons})`);
      for (const m of await getSeason(season, year)) if (eligible(m)) items.set(m.id, m);
    }
    // Plus anything rated, listed, followed or watched from before the window (but nothing from after it).
    const extra = new Set<number>([...ctx.fb.keys(), ...ctx.following]);
    for (const [id, e] of ctx.lists) if (e.status !== "PLANNING") extra.add(id);
    for (const [tvdb, w] of ctx.watch) if (w.watched >= 3) for (const id of ctx.byTvdb.get(tvdb) ?? []) extra.add(id);
    if (save) setJob("profile", "running", "Fetching shows you've rated or watched");
    for (const m of await getMediaByIds([...extra].filter((id) => !items.has(id)).slice(0, 1200))) {
      if (m.isAdult) continue;
      if (opts.until && m.seasonYear && m.season && seasonIdx({ season: m.season, year: m.seasonYear }) >= seasonIdx(end)) continue;
      items.set(m.id, m);
    }

    if (save) setJob("profile", "running", "Scoring genres and tags");
    const fr = franchises(items);
    // Without any library/history, "aired but not picked" says little: weigh those shows lightly so a handful of
    // quiz answers isn't drowned out by hundreds of shows the user simply never heard of.
    const unknownWeight = ctx.hasHistory ? 1 : 0.08;
    const rows = [...items.values()].map((m) => {
      const l = labelOf(m.id, ctx);
      const ago = m.season && m.seasonYear ? Math.max(0, seasonIdx(end) - seasonIdx({ season: m.season, year: m.seasonYear }) - 1) : s.training.seasons;
      const w = ((l.known ? 1 : unknownWeight) / fr.size(m.id)) * Math.max(0.3, (TUNE.decay ?? 0.9) ** ago);
      return { m, l, w };
    });
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
    // Quiz answers (genres "Fantasy", themes "T:Food") are pseudo-counts.
    for (const [key, pref] of Object.entries(s.genrePrefs)) {
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
      feats[f] = { lift: (a.p + b * SMOOTH * minScale) / (a.n + SMOOTH * minScale) / b, n: Math.round(a.n * 10) / 10, p: Math.round(a.p * 10) / 10 };
    }

    // One favourite per franchise: the entry they liked most.
    const favBy = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      if (!r.l.fav || !eligible(r.m) || isShort(r.m)) continue;
      const k = fr.root(r.m.id);
      const cur = favBy.get(k);
      if (!cur || r.l.p > cur.l.p || (r.l.p === cur.l.p && r.m.popularity > cur.m.popularity)) favBy.set(k, r);
    }

    const profile: Profile = {
      builtAt: Date.now(),
      trainedOn: rows.length,
      positives: rows.filter((r) => r.l.p >= 1).length,
      known: rows.filter((r) => r.l.known).length,
      base,
      features: feats,
      favourites: [...favBy.values()]
        .sort((x, y) => y.l.p - x.l.p)
        .slice(0, 300)
        .map((r) => ({ id: r.m.id, title: title(r.m), feats: features(r.m).filter((f) => !QUIET_TAGS.has(f.slice(2))) })),
      sources: ctx.sources,
    };
    if (save) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(profile));
      setJob("profile", "done", `Learned from ${profile.known} shows you've seen or rated`);
    }
    return profile;
  } catch (e) {
    if (save) setJob("profile", "error", (e as Error).message);
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

export const isBuilding = () => building !== null;

export async function getProfile(maxAgeMs = 86_400_000): Promise<Profile> {
  const p = storedProfile();
  if (p && Date.now() - p.builtAt < maxAgeMs) return p;
  return rebuildProfile();
}

// ---------------------------------------------------------------- recommendations

export type Section = "continuing" | "new" | "shorts" | "movies";
/** The user's own relationship with this exact entry. */
export type MyStatus = "watching" | "seen" | "planning" | "following" | "dropped" | null;

export interface Pick {
  id: number;
  title: string;
  altTitle: string | null;
  section: Section;
  carryOver: boolean;
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
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
  /** Direct sequel: the previous season, whether the user watched/kept it, and how many seasons they're behind. */
  continues: { title: string; watched: boolean; kept: boolean; behind: number } | null;
  spinOffOf: string | null;
  compilationOf: { title: string; seen: boolean } | null;
  myStatus: MyStatus;
  reasons: { label: string; lift: number }[];
  warnings: { label: string; lift: number }[];
  similar: string | null;
  excluded: string | null;
  tvdbId: number | null;
  tvdbSeason: number | null;
  tmdbId: number | null;
  inLibrary: boolean;
  seasonMonitored: boolean | null;
  addVia: "sonarr" | "radarr" | null;
  /** Shown when it can't be added; null when it can (or when nothing is connected, where Follow is the action). */
  cantAdd: string | null;
  /** No TVDB match yet, but Sonarr's title search can find it (the UI offers a picker). */
  needsMatch: boolean;
  /** Matched through its earlier season in Sonarr because the community list hasn't caught up yet. */
  matchGuessed: boolean;
  verdict: string | null;
}

const isAnime = (e: { node: { type: string } }) => e.node.type === "ANIME";
const prequelIds = (m: Media) => (m.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL" && isAnime(e)).map((e) => e.node.id);
const parentIds = (m: Media) => (m.relations?.edges ?? []).filter((e) => e.relationType === "PARENT" && isAnime(e)).map((e) => e.node.id);

function jaccard(a: Set<string>, b: string[]) {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  return inter / (a.size + b.length - inter || 1);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtDate = (d: Media["startDate"]) =>
  d?.year ? [d.year, d.month, d.day].filter((x): x is number => !!x).map((x, i) => (i ? String(x).padStart(2, "0") : String(x))).join("-") : null;
/**
 * Score -> 0-100. Slope fitted by `npm run eval` (a = 1.2); the midpoint is set one point below the fitted
 * 50%-kept line (5.6), so 50% here means "you keep roughly 1 in 4 shows like this" and strong picks read 85-95%.
 */
export const toMatch = (score: number) => Math.round(100 / (1 + Math.exp(-(TUNE.ma ?? 1.2) * (score - (TUNE.mb ?? 4.6)))));

export function streamingLinks(m: Media) {
  const seen = new Set<string>();
  const out: { site: string; url: string }[] = [];
  for (const l of m.externalLinks ?? []) {
    if (l.type !== "STREAMING") continue;
    const site = SERVICE_ALIASES[l.site] ?? l.site;
    if (seen.has(site)) continue;
    seen.add(site);
    out.push({ site, url: l.url });
  }
  return out;
}

/** When a show airs past the start of a season (for carry-overs). Unknown episode counts count as "yes". */
function airsInto(m: Media, seasonStart: number) {
  if (m.status !== "RELEASING" || !m.nextAiringEpisode) return false;
  if (!m.episodes) return true;
  const lastAir = m.nextAiringEpisode.airingAt * 1000 + (m.episodes - m.nextAiringEpisode.episode) * 7 * 86_400_000;
  return lastAir >= seasonStart;
}

/**
 * A new season the community list hasn't mapped yet, whose previous season is in Sonarr: same TVDB series, next season
 * number when Sonarr already lists it and nothing else claims it. Otherwise the season stays unknown (new episodes
 * only), which is also right for split-cour "Part 2"s that TVDB files under the same season.
 */
function inferMapping(m: Media, immediate: Media | null, ctx: Ctx): Mapping | undefined {
  if (!EPISODIC_FORMATS.has(m.format ?? "")) return undefined;
  // Already added to Sonarr under exactly this title (by hand, or by Sonarr's own search): that's the match.
  const norm = (t: string | null | undefined) => (t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const names = new Set([norm(m.title.english), norm(m.title.romaji)].filter(Boolean));
  for (const series of ctx.lib.values()) {
    if (!names.has(norm(series.title)) || ctx.byTvdb.has(series.tvdbId)) continue;
    const real = series.seasons.filter((x) => x.seasonNumber > 0).length;
    const out = { tvdbId: series.tvdbId, season: real === 1 ? 1 : null };
    setInferred(m.id, out);
    return out;
  }
  if (!immediate || !EPISODIC_FORMATS.has(immediate.format ?? "")) return undefined;
  const pm = ctx.byAnilist.get(immediate.id);
  const series = pm ? ctx.lib.get(pm.tvdbId) : undefined;
  if (!pm || !series) return undefined;
  const next = pm.season ? pm.season + 1 : null;
  const claimed = (ctx.byTvdb.get(pm.tvdbId) ?? []).some((id) => ctx.byAnilist.get(id)?.season === next);
  const season = next && !claimed && series.seasons.some((x) => x.seasonNumber === next) && !/part\s*(2|ii)|2nd cour|cour 2/i.test(`${m.title.english} ${m.title.romaji}`) ? next : null;
  const out = { tvdbId: pm.tvdbId, season };
  setInferred(m.id, out);
  return out;
}

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

export interface ScoreOptions {
  /** Offline evaluation: ignore everything the user did with the candidate itself (no leakage). */
  blind?: boolean;
  carryIds?: Set<number>;
}

/** Scores candidate shows against a profile. Pure apart from cache reads, so the evaluation can reuse it. */
export function scoreCandidates(candidates: Media[], profile: Profile, ctx: Ctx, opts: ScoreOptions = {}): Pick[] {
  const s = getSettings();
  const kidsLift = profile.features["T:Kids"]?.lift ?? 0;
  const neverGenres = new Set([...s.filters.excludeGenres, ...Object.entries(s.genrePrefs).filter(([k, v]) => v === "never" && !k.includes(":")).map(([g]) => g)]);
  const excludeTags = new Set([
    ...s.filters.excludeTags.filter((t) => !(t === "Kids" && kidsLift >= 1.2)),
    ...(s.filters.noGore ? GORE_TAGS : []),
    ...Object.entries(s.genrePrefs).filter(([k, v]) => v === "never" && k.startsWith("T:")).map(([k]) => k.slice(2)),
  ]);
  const pops = candidates.map((m) => m.popularity).sort((a, b) => a - b);
  const pct = (p: number) => (pops.length > 1 ? pops.filter((x) => x < p).length / (pops.length - 1) : 0.5);
  const sonarrOn = !!(s.sonarr.url && s.sonarr.apiKey);

  return candidates.map((m) => {
    // Walk the direct PREQUEL chain (up to 3 back) to the nearest season the user has a signal for. TV/ONA prequels
    // come first: a series' AniList "prequel" list often includes a movie or recap special next to the real season.
    const episodicFirst = (ids: number[]) =>
      ids
        .map(cachedMedia)
        .filter((x): x is Media => !!x && x.format !== "MUSIC")
        .sort((a, b) => Number(EPISODIC_FORMATS.has(b.format ?? "")) - Number(EPISODIC_FORMATS.has(a.format ?? "")));
    // A recap special or OVA between two seasons isn't a season: look through it to what came before.
    const stepBack = (x: Media) => {
      const out: Media[] = [];
      const seen = new Set<number>();
      const visit = (ids: number[], hops: number) => {
        for (const y of episodicFirst(ids)) {
          if (seen.has(y.id)) continue;
          seen.add(y.id);
          const before = !EPISODIC_FORMATS.has(y.format ?? "") && y.format !== "MOVIE" && hops < 2 ? prequelIds(y) : [];
          if (before.length) visit(before, hops + 1);
          else out.push(y);
        }
      };
      visit(prequelIds(x), 0);
      return episodicFirst(out.map((y) => y.id));
    };
    const immediate = stepBack(m)[0] ?? null;
    let pre: { label: Label; media: Media; depth: number } | null = null;
    const chain = new Set<number>([m.id]);
    let frontier = stepBack(m).map((x) => x.id);
    for (let depth = 0; depth < 3 && frontier.length && !pre; depth++) {
      const next: number[] = [];
      for (const pid of frontier) {
        if (chain.has(pid)) continue;
        chain.add(pid);
        const pm = cachedMedia(pid);
        if (!pm) continue;
        let l = labelOf(pid, ctx);
        // Following a franchise in Sonarr/Radarr is itself the signal, even if the media server shows little watching
        // (people watch on other devices, or Plex history is incomplete): treat a chosen prequel as "kept".
        if ((TUNE.chosePre ?? 1) && l.p < 1 && l.p > 0.3 && chose(pid, ctx)) l = { ...l, p: 1, known: true };
        if (l.known && (l.p >= 1 || l.p <= 0.3) && (!pre || l.p > pre.label.p)) pre = { label: l, media: pm, depth };
        next.push(...stepBack(pm).map((x) => x.id));
      }
      frontier = next;
    }
    // A spin-off / side story of something the user follows earns a small nudge, never a sequel boost.
    const parent = parentIds(m).map(cachedMedia).find((x): x is Media => !!x) ?? null;
    const parentLabel = parent ? labelOf(parent.id, ctx) : null;
    const tiny = isShort(m) || (m.popularity < 1000 && (m.episodes ?? 99) < 6);

    // Features, borrowing the prequel's tags when this entry has too few (common before it airs).
    let feats = features(m, m.status === "NOT_YET_RELEASED" ? 40 : undefined);
    const donor = immediate ?? parent;
    if (feats.filter((f) => f.startsWith("T:")).length < 4 && donor) feats = [...new Set([...feats, ...features(donor).filter((f) => !f.startsWith("G:"))])];
    const g = feats.filter((f) => f.startsWith("G:") && profile.features[f]).map((f) => Math.log(profile.features[f].lift));
    const t = feats.filter((f) => !f.startsWith("G:") && profile.features[f]).map((f) => Math.log(profile.features[f].lift)).sort((a, b) => b - a);
    const taste = (TUNE.taste ?? 0.8) * (GENRE_WEIGHT * mean(g) + (t.length ? mean(t) * 3 + mean(t.slice(0, 4)) : 0)) * (t.length / (t.length + 4));

    const pl = pre?.label;
    let franchise = !pl ? 0 : pl.p >= 1.5 ? (TUNE.frHi ?? 2.5) : pl.p >= 1 ? (TUNE.frMid ?? 1.5) : pl.p <= 0.3 ? (TUNE.frLo ?? -0.5) : 0;
    if (pl && pre && pre.depth > 0 && franchise > 0) franchise -= 0.5 * pre.depth; // a season or more behind
    if (!pl && parentLabel?.known && parentLabel.p >= 1 && !tiny) franchise = 0.5;

    const isMovie = m.format === "MOVIE";
    const map = ctx.byAnilist.get(m.id) ?? (isMovie || opts.blind ? undefined : inferMapping(m, immediate, ctx));
    const tmdbId = isMovie ? (ctx.movieByAnilist.get(m.id) ?? null) : null;
    const imdbId = isMovie ? (ctx.imdbByAnilist.get(m.id) ?? null) : null;
    const inLib = !isMovie && map ? ctx.lib.get(map.tvdbId) : undefined;
    const inLibrary = isMovie ? !!(tmdbId && ctx.movies.has(tmdbId)) : !!inLib;
    const myStatus = opts.blind ? null : ownStatus(m.id, m, ctx, inLibrary);
    const verdict = opts.blind ? null : (ctx.fb.get(m.id) ?? null);

    const verdictAdj = verdict === "disliked" || verdict === "hidden" ? -10 : verdict === "loved" || verdict === "liked" || verdict === "added" ? 3 : 0;
    const statusAdj = myStatus === "planning" ? 1.5 : myStatus === "dropped" ? -6 : 0;
    // Before a show airs its AniList popularity is a fraction of what it ends at (the eval sees final numbers), so the
    // absolute term gets a floor there; the within-season percentile still orders pre-air shows against each other.
    const preAir = m.status === "NOT_YET_RELEASED";
    const logPop = Math.log10(Math.max(m.popularity, (immediate?.popularity ?? 0) * 0.3, 10));
    const popTerm = (TUNE.pct ?? 1.2) * pct(m.popularity) + (TUNE.pop ?? 0.6) * (preAir ? Math.max(logPop, TUNE.preAirPop ?? 4.2) : logPop);
    const score = taste + popTerm + franchise + verdictAdj + statusAdj;
    let match = toMatch(score);
    if (pl && pl.p >= 1.5 && pre?.depth === 0) match = Math.max(match, 90);
    const lowConfidence = (t.length < 4 && !pl) || (tiny && !pl);
    if (tiny) match = Math.min(match, 80);
    // Something they're already watching: the % should never contradict the "Watching" badge.
    const listed = opts.blind ? undefined : ctx.lists.get(m.id);
    if (myStatus === "watching") match = Math.max(match, (listed?.progress ?? 3) >= 3 ? 90 : 75);
    // Compilation / recap films retell a series: label them as such rather than as a spin-off.
    const compilation = isMovie && !!parent && /\b(compilation|recap|recompil|re-?edit|summary)/i.test(m.description ?? "");

    // Where a show came from ("light novel adaptation") ranks, but makes a confusing reason chip, so it isn't shown.
    const byLift = feats.filter((f) => profile.features[f] && !f.startsWith("S:") && !QUIET_TAGS.has(f.slice(2))).map((f) => ({ label: label(f), lift: Math.round(profile.features[f].lift * 10) / 10 }));

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
          const fm = cachedMedia(f.id);
          similar = fm ? title(fm) : f.title;
        }
      }
    }

    const badGenre = m.genres.find((x) => neverGenres.has(x));
    const badTag = m.tags.find((x) => x.rank >= s.training.minTagRank && excludeTags.has(x.name));
    const excluded =
      verdict === "disliked"
        ? "You marked this 👎"
        : verdict === "hidden"
          ? "You hid this"
          : myStatus === "seen"
            ? "You've already seen this"
            : myStatus === "dropped"
              ? "You stopped watching this"
              : continuing
                ? null
                : badGenre && taste < 1
                  ? `You said never ${badGenre}`
                  : badTag
                    ? badTag.name === "Kids"
                      ? "Aimed at young kids"
                      : GORE_TAGS.includes(badTag.name)
                        ? "Graphic violence"
                        : `You said never ${label(`T:${badTag.name}`)}`
                    : null;

    const carryOver = opts.carryIds?.has(m.id) ?? false;
    const continues =
      immediate && (EPISODIC_FORMATS.has(immediate.format ?? "") === EPISODIC_FORMATS.has(m.format ?? "") || isMovie)
        ? {
            // Split cours often share an English title ("Season 2 Part 2" vs "Season 2"); fall back to romaji then.
            title: title(immediate) === title(m) ? (immediate.title.romaji ?? title(immediate)) : title(immediate),
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
    const addVia = isMovie ? ((tmdbId || imdbId) && radarrConfigured() ? "radarr" : null) : sonarrOn ? "sonarr" : null;
    const needsMatch = !isMovie && sonarrOn && !map;
    const matchGuessed = !!map && !ctx.byAnilist.has(m.id);
    const cantAdd = addVia ? null : isMovie ? (radarrConfigured() ? "Not matched to a movie database yet" : null) : null;
    const desc = m.description?.replace(/~!.*?!~/gs, "[spoiler hidden]").replace(/<[^>]+>/g, "").replace(/\s*\(Source:[^)]*\)\s*$/i, "").trim();

    return {
      id: m.id,
      title: title(m),
      altTitle: (m.title.romaji !== title(m) ? m.title.romaji : m.title.english) ?? null,
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
      nextAiring: !isMovie && m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt * 1000, episode: m.nextAiringEpisode.episode } : null,
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
      spinOffOf: !continues && !compilation && !pl && parent ? title(parent) : null,
      compilationOf: compilation && parent ? { title: title(parent), seen: !!parentLabel?.known && parentLabel.p >= 1 } : null,
      myStatus,
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
      needsMatch,
      matchGuessed,
      verdict,
    };
  });
}

export async function recommend(season: Season, year: number, refresh = false): Promise<{ picks: Pick[]; profileBuiltAt: number }> {
  const s = getSettings();
  const [list, profile, ctx] = await Promise.all([getSeason(season, year, refresh), getProfile(), context(refresh)]);
  const countries = new Set(s.training.countries);
  const ok = (m: Media) => !m.isAdult && !!m.format && CANDIDATE_FORMATS.has(m.format) && (!m.countryOfOrigin || countries.has(m.countryOfOrigin));

  // Carry-overs: anything the user follows that started earlier and is still airing into this season.
  const seasonStart = new Date(year, SEASONS.indexOf(season) * 3, 1).getTime();
  const ids = new Set(list.map((m) => m.id));
  const followed = new Set<number>(ctx.following);
  for (const [id, e] of ctx.lists) if (e.status === "CURRENT" || e.status === "PLANNING") followed.add(id);
  // For a season that hasn't started, shows already in Sonarr are on My Shows; don't let them fill the top of next season.
  const upcoming = seasonStart > Date.now();
  if (!upcoming) for (const [tvdb, x] of ctx.lib) if (x.seriesType === "anime" && x.status === "continuing" && x.monitored) for (const id of ctx.byTvdb.get(tvdb) ?? []) followed.add(id);
  const carryCandidates = (await getMediaByIds([...followed].filter((id) => !ids.has(id)).slice(0, 400)).catch(() => [] as Media[])).filter(
    (m) => ok(m) && airsInto(m, seasonStart) && m.seasonYear !== null && (m.seasonYear ?? 0) * 4 + SEASONS.indexOf(m.season ?? "WINTER") < year * 4 + SEASONS.indexOf(season),
  );
  const carryIds = new Set(carryCandidates.map((m) => m.id));
  // AniList pages can repeat a show when popularity shifts mid-pagination.
  const candidates = [...new Map([...list.filter(ok), ...carryCandidates].map((m) => [m.id, m])).values()];

  // Prefetch the prequel chain and parents so sequels can inherit labels, titles and tags.
  let frontier = [...new Set(candidates.flatMap((m) => [...prequelIds(m), ...parentIds(m)]))];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const got = await getMediaByIds(frontier).catch(() => [] as Media[]);
    frontier = [...new Set(got.flatMap(prequelIds))].filter((id) => !cachedMedia(id));
  }

  const picks = scoreCandidates(candidates, profile, ctx, { carryIds });
  picks.sort((a, b) => b.match - a.match || b.score - a.score);
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
