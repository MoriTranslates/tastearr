import type { ArrConn } from "../adapters/arr.js";
import * as sonarr from "../adapters/sonarr.js";
import type { SonarrSeries } from "../adapters/sonarr.js";
import { defaultMonitor, MONITOR_LABEL, monitorOptions, planSeriesAdd, rateTitleMatch, type MonitorChoice } from "../core/add-plan.js";
import { fail } from "../core/errors.js";
import { removeDropped } from "../data/library.js";
import { getSettings } from "./settings.js";

/** The user's Sonarr instances: the library (cached a few minutes), adding shows and monitoring seasons. */

export type { SonarrSeries };

export const testSonarr = (conn: ArrConn) => sonarr.status(conn);
export const sonarrOptions = (conn: ArrConn = getSettings().sonarr) => sonarr.options(conn);

let seriesCache: { at: number; list: SonarrSeries[] } | null = null;

/** A series' `instance` is the address of the Sonarr it lives in (empty = the main one). */
function connOf(instance = ""): ArrConn {
  const s = getSettings();
  if (!instance || instance === s.sonarr.url) return s.sonarr;
  const x = s.sonarrExtra.find((e) => e.url === instance);
  if (!x) throw fail("That Sonarr instance was removed; reload the page", 409);
  return x;
}

export function forgetSeries() {
  seriesCache = null;
}

/** Every series across all Sonarr instances. The main instance wins when the same show is in two. */
export async function sonarrSeries(force = false): Promise<SonarrSeries[]> {
  if (!force && seriesCache && Date.now() - seriesCache.at < 5 * 60_000) return seriesCache.list;
  const list = (await sonarr.allSeries(getSettings().sonarr)).map((x) => ({ ...x, instance: "" }));
  const have = new Set(list.map((x) => x.tvdbId));
  const extra = getSettings().sonarrExtra;
  for (let i = 0; i < extra.length; i++) {
    try {
      for (const x of await sonarr.allSeries(extra[i])) if (!have.has(x.tvdbId)) list.push({ ...x, instance: extra[i].url });
    } catch (e) {
      console.warn(`Sonarr "${extra[i].name}" unreachable: ${(e as Error).message}`);
    }
  }
  seriesCache = { at: Date.now(), list };
  return list;
}

async function ensureTag(conn: ArrConn): Promise<number | null> {
  try {
    return await sonarr.ensureTag(conn);
  } catch {
    return null;
  }
}

async function lookupTvdb(conn: ArrConn, tvdbId: number) {
  const [s] = await sonarr.lookup(conn, `tvdb:${tvdbId}`);
  if (!s) throw fail(`Sonarr found no series for TVDB ${tvdbId}`, 404);
  return s;
}

/** What "Add" will do, for the confirm dialog. */
export async function planAdd(tvdbId: number, season: number | null, firstOfMany = false) {
  const cfg = getSettings().sonarr;
  const s = await lookupTvdb(cfg, tvdbId);
  const [profiles, tags] = await Promise.all([sonarr.qualityProfiles(cfg), sonarr.tags(cfg)]);
  const monitor = defaultMonitor(season, cfg.sequelMonitor, firstOfMany);
  const seasonListed = !season || s.seasons.some((x) => x.seasonNumber === season);
  return {
    title: s.title,
    year: (s.year as number | undefined) ?? null,
    monitor,
    monitorLabel: MONITOR_LABEL[monitor](season),
    season,
    /** The TVDB season exists yet (otherwise Sonarr picks it up when TVDB lists it). */
    seasonListed,
    // Mirrors addSeries: Sonarr only searches when there's something listed to search for.
    search: cfg.searchOnAdd && (monitor === "all" || (monitor === "season" && seasonListed)),
    profile: profiles.find((p) => p.id === cfg.qualityProfileId)?.name ?? null,
    rootFolder: cfg.rootFolderPath,
    tags: [...tags.filter((t) => cfg.tags.includes(t.id)).map((t) => t.label), "tastearr"],
    options: monitorOptions(season),
    /** Seasons TVDB lists for the series, so a hand-matched show can pick its season. */
    seasons: s.seasons.map((x) => x.seasonNumber).filter((n) => n > 0),
  };
}

/** Sonarr's own title search: the fallback when the community AniList -> TVDB list hasn't caught up yet. */
export async function lookupByTitle(titles: string[], year: number | null = null) {
  const seen = new Map<number, ReturnType<typeof rateTitleMatch>>();
  const owned = new Set((await sonarrSeries().catch(() => [] as SonarrSeries[])).map((x) => x.tvdbId));
  for (const t of titles.filter(Boolean).slice(0, 2)) {
    for (const x of (await sonarr.lookup(getSettings().sonarr, encodeURIComponent(t))).slice(0, 6)) {
      if (!x.tvdbId || seen.has(x.tvdbId)) continue;
      seen.set(x.tvdbId, rateTitleMatch(x, titles, year, owned));
    }
  }
  return [...seen.values()].sort((a, b) => b.rank - a.rank).map(({ rank: _r, ...c }) => c);
}

/** Adds a show to Sonarr as an anime series with the chosen monitoring (see core/add-plan.ts). */
export async function addSeries(
  tvdbId: number,
  season: number | null,
  opts: { monitor?: MonitorChoice; search?: boolean; firstOfMany?: boolean } = {},
) {
  const cfg = getSettings().sonarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw fail("Pick a quality profile and root folder in Settings first", 400);
  const s = await lookupTvdb(cfg, tvdbId);
  // Idempotent: a retry after a timeout, or an auto-add run after a crash, finds the series already there (Sonarr's
  // lookup gives library series their id) and reports it instead of failing on "already added".
  if (s.id) return { id: s.id, title: s.title, monitored: "Already in Sonarr", waitingForSeason: false, alreadyAdded: true };
  const choice = opts.monitor ?? defaultMonitor(season, cfg.sequelMonitor, opts.firstOfMany);
  const { monitor, listed, addOptions } = planSeriesAdd(s, season, choice, opts.search ?? cfg.searchOnAdd);
  const tag = await ensureTag(cfg);
  let added: SonarrSeries;
  try {
    added = await sonarr.addSeries(cfg, {
      ...s,
      qualityProfileId: cfg.qualityProfileId,
      rootFolderPath: cfg.rootFolderPath,
      seriesType: "anime",
      seasonFolder: true,
      monitored: monitor !== "none",
      monitorNewItems: monitor === "none" ? "none" : "all",
      tags: [...new Set([...cfg.tags, ...(tag ? [tag] : [])])],
      addOptions,
    });
  } catch (e) {
    // The request may have reached Sonarr even though the answer didn't come back (timeout), or another add won the
    // race. If the series is there now, the add happened.
    const there = await sonarr.seriesByTvdb(cfg, tvdbId).catch(() => null);
    if (!there) throw e;
    added = there;
  } finally {
    seriesCache = null;
  }
  return {
    id: added.id,
    title: added.title,
    monitored: MONITOR_LABEL[monitor](season),
    waitingForSeason: monitor === "season" && !listed,
    alreadyAdded: false,
  };
}

export async function setMonitored(seriesId: number, monitored: boolean, instance = "") {
  const c = connOf(instance);
  const full = await sonarr.getSeries(c, seriesId);
  await sonarr.putSeries(c, seriesId, { ...full, monitored });
  seriesCache = null;
}

/** Whether monitoring a season would also switch an unmonitored series back on (shown in the confirm dialog). */
export async function seriesMonitored(tvdbId: number) {
  return (await sonarrSeries()).find((x) => x.tvdbId === tvdbId)?.monitored ?? null;
}

/**
 * How long "monitor this season" waits for Sonarr to refresh a series from TVDB. Kept well under the usual 60-second
 * reverse-proxy timeout; when the refresh takes longer the series is set to pick the season up when it appears.
 */
export const REFRESH_WAIT = { polls: 10, everyMs: 2000 };

/** Monitors one season of a series that's already in Sonarr (refreshing it first if TVDB is newer) and searches for it. */
export async function monitorSeason(tvdbId: number, season: number, search = getSettings().sonarr.searchOnAdd) {
  const s = (await sonarrSeries(true)).find((x) => x.tvdbId === tvdbId);
  if (!s) throw fail("Series is not in Sonarr", 404);
  const c = connOf(s.instance);
  let full = await sonarr.getSeries(c, s.id);
  if (!full.seasons.some((x) => x.seasonNumber === season)) {
    const cmd = await sonarr.command(c, { name: "RefreshSeries", seriesId: s.id });
    for (let i = 0; i < REFRESH_WAIT.polls; i++) {
      await new Promise((r) => setTimeout(r, REFRESH_WAIT.everyMs));
      const st = await sonarr.commandStatus(c, cmd.id);
      if (st.status === "completed" || st.status === "failed") break;
    }
    full = await sonarr.getSeries(c, s.id);
  }
  const target = full.seasons.find((x) => x.seasonNumber === season);
  // Series-level monitoring is what makes Sonarr grab new episodes; the preview tells the user when this flips it back on.
  const resumed = !full.monitored;
  full.monitored = true;
  if (target) target.monitored = true;
  else full.monitorNewItems = "all"; // TVDB hasn't listed it yet; Sonarr monitors it when it appears
  await sonarr.putSeries(c, s.id, full);
  removeDropped(tvdbId);
  if (target && search) await sonarr.command(c, { name: "SeasonSearch", seriesId: s.id, seasonNumber: season });
  seriesCache = null;
  return { id: s.id, title: s.title, season, waitingForSeason: !target, resumedSeries: resumed };
}
