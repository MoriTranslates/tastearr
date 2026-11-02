import type { AddPlan, MonitorChoice } from "../../shared/api.js";
import { fail, parseId } from "../core/errors.js";
import type { Media } from "../core/taste/media.js";
import { isSplitCour } from "../core/taste/sequels.js";
import { getMediaByIds } from "./catalog.js";
import { invalidateContext } from "./context.js";
import { firstOfMany, mapAnilist, mappingTables, saveOverride } from "./mapping.js";
import { setFeedback } from "./picks.js";
import { addMovie } from "./radarr.js";
import { getSettings } from "./settings.js";
import { addSeries, lookupByTitle, monitorSeason, planAdd, seriesMonitored, sonarrSeries } from "./sonarr.js";

/** The Add / Monitor buttons on a pick: preview what will happen, find a TVDB match by title, then do it. */

async function mediaOrFail(anilistId: number) {
  const [m] = await getMediaByIds([anilistId]);
  if (!m) throw fail("Unknown show", 404);
  return m;
}

const titlesOf = (m: Media) => [m.title.english ?? "", m.title.romaji ?? ""];
const startYear = (m: Media) => m.startDate?.year ?? m.seasonYear ?? null;

/**
 * The TVDB season for a show matched by hand: one past its earlier season's when that maps to the same series. A split
 * cour ("Part 2", "2nd cour") is filed by TVDB under the same season as its first half.
 */
async function guessSeason(m: Media, tvdbId: number) {
  const splitCour = isSplitCour(m);
  // Walk back through recap specials/OVAs (TVDB season 0) to the last real season, like the picks do.
  let ids = (m.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL").map((e) => e.node.id);
  for (let depth = 0; depth < 3 && ids.length; depth++) {
    const next: number[] = [];
    for (const pid of ids) {
      const pm = await mapAnilist(pid);
      if (pm?.tvdbId === tvdbId && pm.season) return splitCour ? pm.season : pm.season + 1;
      const [pmedia] = await getMediaByIds([pid]);
      if (pmedia && pmedia.format !== "TV" && pmedia.format !== "ONA")
        next.push(...(pmedia.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL").map((e) => e.node.id));
    }
    ids = next;
  }
  return null;
}

/**
 * What "Add" will do, shown in the confirm dialog before anything is written to Sonarr/Radarr. `rawTvdb` (and
 * optionally `rawSeason`) is a candidate picked from Sonarr's title search, as sent by the browser.
 */
export async function planForPick(anilistId: number, rawTvdb?: string, rawSeason?: string): Promise<AddPlan> {
  const m = await mediaOrFail(anilistId);
  if (m.format === "MOVIE") {
    const t = await mappingTables();
    const tmdb = t.movieByAnilist.get(anilistId);
    const imdb = t.imdbByAnilist.get(anilistId);
    if (!tmdb && !imdb) throw fail("This movie isn't matched to TMDB or IMDb yet, so Radarr can't find it", 422);
    const r = getSettings().radarr;
    return {
      app: "radarr",
      title: m.title.english || m.title.romaji,
      rootFolder: r.rootFolderPath,
      search: r.searchOnAdd,
      minimumAvailability: r.minimumAvailability,
    };
  }
  // A candidate picked from Sonarr's title search: preview it with the season guessed from its earlier season.
  if (rawTvdb) {
    const pickedTvdb = parseId(rawTvdb);
    const season = rawSeason ? parseId(rawSeason) : await guessSeason(m, pickedTvdb);
    const owned = (await sonarrSeries()).some((x) => x.tvdbId === pickedTvdb);
    return {
      app: "sonarr",
      ...(await planAdd(pickedTvdb, season)),
      alreadyInLibrary: owned,
      resumesSeries: (await seriesMonitored(pickedTvdb)) === false,
    };
  }
  const map = await mapAnilist(anilistId);
  if (!map) return { app: "sonarr", needsMatch: true };
  return {
    app: "sonarr",
    ...(await planAdd(map.tvdbId, map.season, await firstOfMany(map))),
    resumesSeries: (await seriesMonitored(map.tvdbId)) === false,
  };
}

/** Sonarr title-search candidates when the community mapping has no TVDB match yet. */
export async function matchCandidates(anilistId: number) {
  const m = await mediaOrFail(anilistId);
  return lookupByTitle(titlesOf(m), startYear(m));
}

export interface AddRequest {
  monitor?: MonitorChoice;
  search?: boolean;
  /** A match picked from Sonarr's title search (raw from the body), and optionally its season. */
  tvdbId?: unknown;
  /** Raw from the request body; used when it is a whole number 1-100, otherwise guessed. */
  season?: unknown;
}

/** Adds a pick to Radarr (movies) or Sonarr, or monitors its season when the series is already there. */
export async function addPick(anilistId: number, req: AddRequest) {
  const m = await mediaOrFail(anilistId);
  let r;
  if (m.format === "MOVIE") {
    const t = await mappingTables();
    r = await addMovie({ tmdbId: t.movieByAnilist.get(anilistId), imdbId: t.imdbByAnilist.get(anilistId) });
  } else if (req.tvdbId) {
    // A match picked from Sonarr's title search. Only results of that search are accepted, and the match is
    // remembered only once Sonarr took it, so a failed add can't leave a wrong match behind.
    const tvdbId = parseId(String(req.tvdbId));
    const current = await mapAnilist(anilistId);
    const cands = current?.tvdbId === tvdbId ? [] : await lookupByTitle(titlesOf(m), startYear(m));
    if (current?.tvdbId !== tvdbId && !cands.some((c) => c.tvdbId === tvdbId))
      throw fail("That isn't one of Sonarr's matches for this show", 422);
    const asked = Number(req.season);
    const season = Number.isInteger(asked) && asked >= 1 && asked <= 100 ? asked : await guessSeason(m, tvdbId);
    const owned = (await sonarrSeries(true)).some((x) => x.tvdbId === tvdbId);
    // Never remember "this show is that series, season unknown" for something already in Sonarr: it would hide the
    // "get the new season" choice for good. Ask for the season instead.
    if (owned && !season) throw fail("This series is already in Sonarr. Choose which season this is.", 422);
    if (owned) r = await monitorSeason(tvdbId, season!);
    else r = await addSeries(tvdbId, season, { monitor: req.monitor, search: req.search });
    await saveOverride(anilistId, tvdbId, season);
  } else {
    const map = await mapAnilist(anilistId);
    if (!map) throw fail("Pick the matching show first", 422);
    const owned = (await sonarrSeries()).some((x) => x.tvdbId === map.tvdbId);
    if (owned) {
      if (!map.season) throw fail("This show is already in Sonarr", 409);
      r = await monitorSeason(map.tvdbId, map.season);
    } else r = await addSeries(map.tvdbId, map.season, { monitor: req.monitor, search: req.search, firstOfMany: await firstOfMany(map) });
  }
  setFeedback(anilistId, "added");
  invalidateContext();
  return r;
}

/** Monitors the pick's season of a series already in Sonarr. */
export async function monitorPick(anilistId: number, search?: boolean) {
  const map = await mapAnilist(anilistId);
  if (!map?.season) throw fail("Unknown season number for this entry", 422);
  const r = await monitorSeason(map.tvdbId, map.season, search);
  setFeedback(anilistId, "added");
  invalidateContext();
  return r;
}
