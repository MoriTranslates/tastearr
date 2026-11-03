import { title } from "../core/taste/features.js";
import type { Media } from "../core/taste/media.js";
import type { Ctx, LibraryMovie, LibrarySeries, ListEntry, TasteEnv, WatchState } from "../core/taste/types.js";
import { allFeedback, verdicts } from "../data/feedback.js";
import { followedIds } from "../data/following.js";
import { droppedSet } from "../data/library.js";
import { cachedMedia } from "./catalog.js";
import { listEntries } from "./lists.js";
import { mappingTables } from "./mapping.js";
import { watchStates } from "./mediaserver.js";
import { radarrMovies } from "./radarr.js";
import { getSettings, radarrConfigured, sonarrConfigured } from "./settings.js";
import { sonarrLibrary } from "./sonarr.js";

/**
 * The taste engine's inputs: everything known about the user (Sonarr, Radarr, Plex/Jellyfin, lists, ratings, follows),
 * gathered from the adapters and database into one plain `Ctx`, cached for 10 minutes and shared by concurrent callers.
 */

/** Dev-only knob for `npm run eval` experiments, e.g. TASTEARR_TUNE='{"pop":0.5}'. */
const TUNE: Record<string, number> = (() => {
  try {
    return JSON.parse(process.env.TASTEARR_TUNE ?? "{}");
  } catch {
    return {};
  }
})();

/** Current settings and the media cache, as the taste engine wants them. */
export function tasteEnv(): TasteEnv {
  const s = getSettings();
  return {
    config: {
      training: s.training,
      filters: s.filters,
      genrePrefs: s.genrePrefs,
      titleLanguage: s.display.titleLanguage,
      sonarrOn: sonarrConfigured(),
      radarrOn: radarrConfigured(),
      tune: TUNE,
    },
    media: cachedMedia,
  };
}

/** A show's title in the language the user picked. */
export const titleOf = (m: Media) => title(m, getSettings().display.titleLanguage);

let ctxCache: { at: number; ctx: Ctx; gen: number; force: boolean } | null = null;
/** A build in progress, shared by callers that arrive meanwhile (each one would otherwise rescan Sonarr and Plex). */
let ctxBuilding: { gen: number; force: boolean; p: Promise<Ctx> } | null = null;
/** Bumped by invalidateContext: a build that started before a change must not be cached or shared afterwards. */
let ctxGen = 0;

/**
 * The user context, cached for 10 minutes. `force` reads every source fresh; it never joins a build in progress that
 * wasn't forced (that one may reuse library lists cached for minutes), only another forced one.
 */
export async function context(force = false): Promise<Ctx> {
  if (!force && ctxCache && Date.now() - ctxCache.at < 10 * 60_000) return ctxCache.ctx;
  if (ctxBuilding?.gen === ctxGen && (ctxBuilding.force || !force)) return ctxBuilding.p;
  const gen = ctxGen;
  const p = buildContext(force).then((ctx) => {
    // A non-forced build finishing after a forced one of the same generation must not replace the fresher result.
    const staler = !force && ctxCache?.gen === gen && ctxCache.force;
    if (gen === ctxGen && !staler) ctxCache = { at: Date.now(), ctx, gen, force };
    return ctx;
  });
  ctxBuilding = { gen, force, p };
  void p
    .finally(() => {
      if (ctxBuilding?.p === p) ctxBuilding = null;
    })
    .catch(() => undefined);
  return p;
}

/** Forgets the cached context after anything that changes it (settings, library, follows, matches). */
export function invalidateContext() {
  ctxCache = null;
  ctxGen++;
}

/** Keeps the cached context's ratings current after a verdict changed (cheaper than a rebuild). */
export function refreshCachedFeedback() {
  if (ctxCache) ctxCache.ctx.fb = verdicts();
}

/** Watch progress from the media server, cached with the context (My Shows reuses it instead of rescanning Plex). */
export async function cachedWatch() {
  return (await context()).watch;
}

/**
 * Configured sources that couldn't be read, by name, and when each was first seen failing (cleared when it answers
 * again). In memory: for the "couldn't be read since ..." warning, so a source that stays down is pointed out.
 */
const downSince = new Map<string, number>();
export function sourcesDown(): { source: string; since: number }[] {
  return [...downSince].map(([source, since]) => ({ source, since }));
}

type Missing = { sources: Record<string, string>; degraded: string[]; names: string[] };

/**
 * Loads one configured source; a failure is recorded in `sources` (shown on the Taste page) and in `degraded` instead
 * of failing the build, so the context is still usable for display while writers can tell it is incomplete.
 */
async function tryLoad<T>(m: Missing, key: string, name: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (e) {
    m.sources[key] = `error: ${(e as Error).message}`;
    m.degraded.push(`${key}: ${(e as Error).message}`);
    m.names.push(name);
    return null;
  }
}

async function buildContext(force: boolean): Promise<Ctx> {
  const s = getSettings();
  const sources: Record<string, string> = {};
  const degraded: string[] = [];
  const m: Missing = { sources, degraded, names: [] };
  const { byAnilist, byTvdb, movieByAnilist, imdbByAnilist } = await mappingTables();

  const lib = new Map<number, LibrarySeries>();
  if (s.sonarr.url && s.sonarr.apiKey) {
    const got = await tryLoad(m, "sonarr", "Sonarr", () => sonarrLibrary(force));
    if (got) {
      for (const x of got.list) lib.set(x.tvdbId, x);
      sources.sonarr = `${lib.size} series`;
      // An extra instance that didn't answer: its shows would look missing (not owned, never watched).
      if (got.failed.length) {
        sources.sonarr += ` (error: ${got.failed.join("; ")})`;
        degraded.push(...got.failed);
        m.names.push(...got.failedNames);
      }
    }
  }

  const movies = new Map<number, LibraryMovie>();
  if (radarrConfigured()) {
    const list = await tryLoad(m, "radarr", "Radarr", () => radarrMovies(force));
    if (list) {
      for (const x of list) movies.set(x.tmdbId, x);
      sources.radarr = `${movies.size} movies`;
    }
  }

  let watch = new Map<number, WatchState>();
  if (s.media.type !== "none" && s.media.url && s.media.token) {
    const w = await tryLoad(m, "media", s.media.type === "plex" ? "Plex" : "Jellyfin", watchStates);
    if (w) {
      watch = w;
      sources.media = `${[...watch.values()].filter((x) => x.watched > 0).length} shows with watch history`;
    }
  }

  const fbRows = allFeedback();
  const quiz = fbRows.filter((r) => r.source === "quiz").length;
  if (quiz || fbRows.length) sources.ratings = `${quiz} quiz answers, ${fbRows.length - quiz} ratings`;

  const lists = new Map<number, ListEntry>();
  for (const e of listEntries()) if (!lists.has(e.id) || e.source === "anilist") lists.set(e.id, e);
  const listScored = [...lists.values()].some((e) => e.score !== null && e.score > 0);
  if (lists.size) sources.lists = `${lists.size} AniList/MAL entries${listScored ? "" : " (no scores)"}`;

  const dropped = droppedSet();
  if (dropped.size) sources.dropped = `${dropped.size} shows you're not into`;
  for (const name of [...downSince.keys()]) if (!m.names.includes(name)) downSince.delete(name);
  for (const name of m.names) if (!downSince.has(name)) downSince.set(name, Date.now());
  return {
    lib,
    movies,
    watch,
    fb: new Map(fbRows.map((r) => [r.anilist_id, r.verdict])),
    dropped,
    lists,
    listScored,
    following: new Set(followedIds()),
    byAnilist,
    byTvdb,
    movieByAnilist,
    imdbByAnilist,
    hasHistory: lib.size > 0 || movies.size > 0 || watch.size > 0 || lists.size > 0,
    sources,
    degraded,
    missing: m.names,
  };
}
