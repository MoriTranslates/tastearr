import { db } from "./db.js";
import { getSettings, type Settings } from "./settings.js";

export interface SonarrSeason { seasonNumber: number; monitored: boolean; statistics?: { episodeFileCount: number; totalEpisodeCount: number; episodeCount: number } }
export interface SonarrSeries { id: number; tvdbId: number; title: string; seriesType: string; status: string; monitored: boolean; seasons: SonarrSeason[]; [k: string]: unknown }

type Conn = Pick<Settings["sonarr"], "url" | "apiKey">;

async function call<T>(method: string, path: string, body?: unknown, conn: Conn = getSettings().sonarr): Promise<T> {
  if (!conn.url || !conn.apiKey) throw new Error("Sonarr is not configured");
  if (!/^https?:\/\//i.test(conn.url)) throw new Error("Sonarr URL must start with http:// or https://");
  const res = await fetch(`${conn.url}/api/v3${path}`, {
    method,
    headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Sonarr ${method} ${path.split("?")[0]} failed (HTTP ${res.status})`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function testSonarr(conn: Conn) {
  const s = await call<{ version: string; appName?: string }>("GET", "/system/status", undefined, conn);
  if (s.appName && s.appName !== "Sonarr") throw new Error(`That's ${s.appName}, not Sonarr`);
  return { version: s.version };
}

export async function sonarrOptions(conn: Conn = getSettings().sonarr) {
  const [profiles, roots, tags] = await Promise.all([
    call<{ id: number; name: string }[]>("GET", "/qualityprofile", undefined, conn),
    call<{ id: number; path: string }[]>("GET", "/rootfolder", undefined, conn),
    call<{ id: number; label: string }[]>("GET", "/tag", undefined, conn),
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

/** Whether the user has (or wants) a given TVDB season: monitored or has files. Null if Sonarr doesn't list it. */
export function seasonOwned(s: SonarrSeries, season: number | null) {
  if (season === null) return s.seasons.some((x) => x.seasonNumber > 0 && (x.monitored || (x.statistics?.episodeFileCount ?? 0) > 0));
  const x = s.seasons.find((y) => y.seasonNumber === season);
  if (!x) return null;
  return x.monitored || (x.statistics?.episodeFileCount ?? 0) > 0;
}

async function ensureTag(): Promise<number | null> {
  try {
    const tags = await call<{ id: number; label: string }[]>("GET", "/tag");
    return (tags.find((t) => t.label === "tastearr") ?? (await call<{ id: number }>("POST", "/tag", { label: "tastearr" }))).id;
  } catch {
    return null;
  }
}

/**
 * Adds a show to Sonarr as an anime series. For a sequel (season > 1) with sequelMonitor = newSeason,
 * only that season is monitored. If TVDB doesn't list that season yet, nothing existing is monitored and
 * Sonarr picks the season up as a future one, so the back catalogue is never downloaded by surprise.
 */
export async function addSeries(tvdbId: number, season: number | null) {
  const cfg = getSettings().sonarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw new Error("Pick a quality profile and root folder in Settings first");
  const [s] = await call<SonarrSeries[]>("GET", `/series/lookup?term=tvdb:${tvdbId}`);
  if (!s) throw new Error(`Sonarr found no series for TVDB ${tvdbId}`);
  const sequel = cfg.sequelMonitor === "newSeason" && !!season && season > 1;
  const listed = sequel && s.seasons.some((x) => x.seasonNumber === season);
  for (const x of s.seasons) x.monitored = sequel ? listed && x.seasonNumber === season : x.seasonNumber > 0;
  const tag = await ensureTag();
  const body = {
    ...s,
    qualityProfileId: cfg.qualityProfileId,
    rootFolderPath: cfg.rootFolderPath,
    seriesType: "anime",
    seasonFolder: true,
    monitored: true,
    monitorNewItems: "all",
    tags: [...new Set([...cfg.tags, ...(tag ? [tag] : [])])],
    addOptions: sequel
      ? listed
        ? { searchForMissingEpisodes: cfg.searchOnAdd }
        : { monitor: "future", searchForMissingEpisodes: false }
      : { monitor: "all", searchForMissingEpisodes: cfg.searchOnAdd },
  };
  const added = await call<SonarrSeries>("POST", "/series", body);
  seriesCache = null;
  return { id: added.id, title: added.title, monitoredSeason: sequel ? season : null, waitingForSeason: sequel && !listed };
}

export async function setMonitored(seriesId: number, monitored: boolean) {
  const full = await call<SonarrSeries>("GET", `/series/${seriesId}`);
  await call("PUT", `/series/${seriesId}`, { ...full, monitored });
  seriesCache = null;
}

/** Monitors one season of a series that's already in Sonarr (refreshing it first if TVDB is newer) and searches for it. */
export async function monitorSeason(tvdbId: number, season: number) {
  const s = (await sonarrSeries(true)).find((x) => x.tvdbId === tvdbId);
  if (!s) throw new Error("Series is not in Sonarr");
  let full = await call<SonarrSeries>("GET", `/series/${s.id}`);
  if (!full.seasons.some((x) => x.seasonNumber === season)) {
    const cmd = await call<{ id: number }>("POST", "/command", { name: "RefreshSeries", seriesId: s.id });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await call<{ status: string }>("GET", `/command/${cmd.id}`);
      if (st.status === "completed" || st.status === "failed") break;
    }
    full = await call<SonarrSeries>("GET", `/series/${s.id}`);
  }
  const target = full.seasons.find((x) => x.seasonNumber === season);
  // Series-level monitoring is what makes Sonarr grab new episodes; season-level alone isn't enough.
  full.monitored = true;
  if (target) target.monitored = true;
  else full.monitorNewItems = "all"; // TVDB hasn't listed it yet; Sonarr monitors it when it appears
  await call("PUT", `/series/${s.id}`, full);
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  if (target && getSettings().sonarr.searchOnAdd) await call("POST", "/command", { name: "SeasonSearch", seriesId: s.id, seasonNumber: season });
  seriesCache = null;
  return { id: s.id, title: s.title, season, waitingForSeason: !target };
}
