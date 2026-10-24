import { getSettings } from "./settings.js";

interface SonarrSeason { seasonNumber: number; monitored: boolean }
export interface SonarrSeries { id: number; tvdbId: number; title: string; seasons: SonarrSeason[]; [k: string]: unknown }

async function call<T>(method: string, path: string, body?: unknown, conn = getSettings().sonarr): Promise<T> {
  if (!conn.url || !conn.apiKey) throw new Error("Sonarr is not configured");
  const res = await fetch(`${conn.url}/api/v3${path}`, {
    method,
    headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Sonarr ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function testSonarr(url: string, apiKey: string) {
  const s = await call<{ version: string }>("GET", "/system/status", undefined, { ...getSettings().sonarr, url: url.replace(/\/+$/, ""), apiKey });
  return { version: s.version };
}

export async function sonarrOptions() {
  const [profiles, roots, tags] = await Promise.all([
    call<{ id: number; name: string }[]>("GET", "/qualityprofile"),
    call<{ id: number; path: string }[]>("GET", "/rootfolder"),
    call<{ id: number; label: string }[]>("GET", "/tag"),
  ]);
  return { profiles: profiles.map(({ id, name }) => ({ id, name })), roots: roots.map(({ id, path }) => ({ id, path })), tags };
}

let seriesCache: { at: number; list: SonarrSeries[] } | null = null;

export async function sonarrSeries(force = false): Promise<SonarrSeries[]> {
  if (!force && seriesCache && Date.now() - seriesCache.at < 5 * 60_000) return seriesCache.list;
  const list = await call<SonarrSeries[]>("GET", "/series");
  seriesCache = { at: Date.now(), list };
  return list;
}

/**
 * Adds a show to Sonarr as an anime series. For a sequel (season > 1) with sequelMonitor = newSeason,
 * only that season is monitored so earlier seasons aren't downloaded.
 */
export async function addSeries(tvdbId: number, season: number | null) {
  const cfg = getSettings().sonarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw new Error("Pick a quality profile and root folder in Settings first");
  const [s] = await call<SonarrSeries[]>("GET", `/series/lookup?term=tvdb:${tvdbId}`);
  if (!s) throw new Error(`Sonarr found no series for TVDB ${tvdbId}`);
  const onlySeason = cfg.sequelMonitor === "newSeason" && season && season > 1 && s.seasons.some((x) => x.seasonNumber === season) ? season : null;
  for (const x of s.seasons) x.monitored = onlySeason ? x.seasonNumber === onlySeason : x.seasonNumber > 0;
  const body = {
    ...s,
    qualityProfileId: cfg.qualityProfileId,
    rootFolderPath: cfg.rootFolderPath,
    seriesType: "anime",
    seasonFolder: true,
    monitored: true,
    monitorNewItems: "all",
    tags: cfg.tags,
    addOptions: onlySeason ? { searchForMissingEpisodes: cfg.searchOnAdd } : { monitor: "all", searchForMissingEpisodes: cfg.searchOnAdd },
  };
  const added = await call<SonarrSeries>("POST", "/series", body);
  seriesCache = null;
  return { id: added.id, title: added.title, monitoredSeason: onlySeason };
}

export async function setMonitored(seriesId: number, monitored: boolean) {
  const full = await call<SonarrSeries>("GET", `/series/${seriesId}`);
  await call("PUT", `/series/${seriesId}`, { ...full, monitored });
  seriesCache = null;
}

/** Monitors one season of a series that's already in Sonarr and searches for it. */
export async function monitorSeason(tvdbId: number, season: number) {
  const s = (await sonarrSeries(true)).find((x) => x.tvdbId === tvdbId);
  if (!s) throw new Error("Series is not in Sonarr");
  const full = await call<SonarrSeries>("GET", `/series/${s.id}`);
  const target = full.seasons.find((x) => x.seasonNumber === season);
  if (!target) throw new Error(`Sonarr doesn't list season ${season} yet`);
  target.monitored = true;
  await call("PUT", `/series/${s.id}`, full);
  if (getSettings().sonarr.searchOnAdd) await call("POST", "/command", { name: "SeasonSearch", seriesId: s.id, seasonNumber: season });
  seriesCache = null;
  return { id: s.id, title: s.title, season };
}
