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

export type MonitorChoice = "season" | "all" | "future" | "none";

export interface AddPlan {
  title: string;
  year: number | null;
  /** What will be monitored, in plain words. */
  monitorLabel: string;
  monitor: MonitorChoice;
  season: number | null;
  /** The TVDB season exists yet (otherwise Sonarr picks it up when TVDB lists it). */
  seasonListed: boolean;
  search: boolean;
  profile: string | null;
  rootFolder: string;
  tags: string[];
  options: { value: MonitorChoice; label: string }[];
}

/** Default monitoring for a pick: a sequel the user doesn't own gets only its season; anything unclear gets "future". */
function defaultMonitor(season: number | null, cfg = getSettings().sonarr): MonitorChoice {
  if (season === 1) return "all";
  if (season && season > 1) return cfg.sequelMonitor === "newSeason" ? "season" : "all";
  return "future"; // season unknown or specials: never grab a whole back catalogue by surprise
}

const MONITOR_LABEL: Record<MonitorChoice, (s: number | null) => string> = {
  season: (s) => `Season ${s} only`,
  all: () => "All seasons",
  future: () => "Only new episodes from now on",
  none: () => "Nothing (add it unmonitored)",
};

export async function planAdd(tvdbId: number, season: number | null): Promise<AddPlan> {
  const cfg = getSettings().sonarr;
  const [s] = await call<SonarrSeries[]>("GET", `/series/lookup?term=tvdb:${tvdbId}`);
  if (!s) throw new Error(`Sonarr found no series for TVDB ${tvdbId}`);
  const [profiles, tags] = await Promise.all([call<{ id: number; name: string }[]>("GET", "/qualityprofile"), call<{ id: number; label: string }[]>("GET", "/tag")]);
  const monitor = defaultMonitor(season, cfg);
  const options: { value: MonitorChoice; label: string }[] = [];
  if (season && season > 1) options.push({ value: "season", label: MONITOR_LABEL.season(season) });
  options.push({ value: "all", label: MONITOR_LABEL.all(null) }, { value: "future", label: MONITOR_LABEL.future(null) }, { value: "none", label: MONITOR_LABEL.none(null) });
  return {
    title: s.title,
    year: (s.year as number | undefined) ?? null,
    monitor,
    monitorLabel: MONITOR_LABEL[monitor](season),
    season,
    seasonListed: !season || s.seasons.some((x) => x.seasonNumber === season),
    search: cfg.searchOnAdd && monitor !== "none" && monitor !== "future",
    profile: profiles.find((p) => p.id === cfg.qualityProfileId)?.name ?? null,
    rootFolder: cfg.rootFolderPath,
    tags: [...tags.filter((t) => cfg.tags.includes(t.id)).map((t) => t.label), "tastearr"],
    options,
  };
}

/** Sonarr's own title search: the fallback when the community AniList -> TVDB list hasn't caught up yet. */
export async function lookupByTitle(titles: string[]) {
  const seen = new Map<number, { tvdbId: number; title: string; year: number | null; network: string | null; seasons: number[]; overview: string | null }>();
  for (const t of titles.filter(Boolean).slice(0, 2)) {
    for (const x of (await call<SonarrSeries[]>("GET", `/series/lookup?term=${encodeURIComponent(t)}`)).slice(0, 6)) {
      if (!x.tvdbId || seen.has(x.tvdbId)) continue;
      seen.set(x.tvdbId, {
        tvdbId: x.tvdbId,
        title: x.title,
        year: (x.year as number | undefined) ?? null,
        network: (x.network as string | undefined) ?? null,
        seasons: x.seasons.map((y) => y.seasonNumber).filter((n) => n > 0),
        overview: ((x.overview as string | undefined) ?? "").slice(0, 200) || null,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Adds a show to Sonarr as an anime series with the chosen monitoring. The default (see defaultMonitor) never
 * downloads a back catalogue the user didn't ask for: sequels get only their season, unclear cases only new episodes.
 */
export async function addSeries(tvdbId: number, season: number | null, opts: { monitor?: MonitorChoice; search?: boolean } = {}) {
  const cfg = getSettings().sonarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw new Error("Pick a quality profile and root folder in Settings first");
  const [s] = await call<SonarrSeries[]>("GET", `/series/lookup?term=tvdb:${tvdbId}`);
  if (!s) throw new Error(`Sonarr found no series for TVDB ${tvdbId}`);
  let monitor = opts.monitor ?? defaultMonitor(season, cfg);
  if (monitor === "season" && !(season && season > 1)) monitor = "future";
  const listed = monitor === "season" && s.seasons.some((x) => x.seasonNumber === season);
  for (const x of s.seasons) x.monitored = monitor === "all" ? x.seasonNumber > 0 : monitor === "season" ? listed && x.seasonNumber === season : false;
  const search = (opts.search ?? cfg.searchOnAdd) && (monitor === "all" || listed);
  const tag = await ensureTag();
  const addOptions =
    monitor === "season"
      ? listed
        ? { searchForMissingEpisodes: search }
        : { monitor: "future", searchForMissingEpisodes: false }
      : monitor === "all"
        ? { monitor: "all", searchForMissingEpisodes: search }
        : { monitor: monitor === "future" ? "future" : "none", searchForMissingEpisodes: false };
  const added = await call<SonarrSeries>("POST", "/series", {
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
  seriesCache = null;
  return { id: added.id, title: added.title, monitored: MONITOR_LABEL[monitor](season), waitingForSeason: monitor === "season" && !listed };
}

export async function setMonitored(seriesId: number, monitored: boolean) {
  const full = await call<SonarrSeries>("GET", `/series/${seriesId}`);
  await call("PUT", `/series/${seriesId}`, { ...full, monitored });
  seriesCache = null;
}

/** Whether monitoring a season would also switch an unmonitored series back on (shown in the confirm dialog). */
export async function seriesMonitored(tvdbId: number) {
  return (await sonarrSeries()).find((x) => x.tvdbId === tvdbId)?.monitored ?? null;
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
  // Series-level monitoring is what makes Sonarr grab new episodes; the preview tells the user when this flips it back on.
  const resumed = !full.monitored;
  full.monitored = true;
  if (target) target.monitored = true;
  else full.monitorNewItems = "all"; // TVDB hasn't listed it yet; Sonarr monitors it when it appears
  await call("PUT", `/series/${s.id}`, full);
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  if (target && getSettings().sonarr.searchOnAdd) await call("POST", "/command", { name: "SeasonSearch", seriesId: s.id, seasonNumber: season });
  seriesCache = null;
  return { id: s.id, title: s.title, season, waitingForSeason: !target, resumedSeries: resumed };
}
