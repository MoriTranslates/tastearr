import { db } from "./db.js";
import { getSettings, type Settings } from "./settings.js";

export interface SonarrSeason { seasonNumber: number; monitored: boolean; statistics?: { episodeFileCount: number; totalEpisodeCount: number; episodeCount: number } }
export interface SonarrSeries { id: number; tvdbId: number; title: string; seriesType: string; status: string; monitored: boolean; seasons: SonarrSeason[]; instance?: string; [k: string]: unknown }

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

/** A series' `instance` is the address of the Sonarr it lives in (empty = the main one). */
function connOf(instance = ""): Conn {
  const s = getSettings();
  if (!instance || instance === s.sonarr.url) return s.sonarr;
  const x = s.sonarrExtra.find((e) => e.url === instance);
  if (!x) throw new Error("That Sonarr instance was removed; reload the page");
  return x;
}

export function forgetSeries() {
  seriesCache = null;
}

/** Every series across all Sonarr instances. The main instance wins when the same show is in two. */
export async function sonarrSeries(force = false): Promise<SonarrSeries[]> {
  if (!force && seriesCache && Date.now() - seriesCache.at < 5 * 60_000) return seriesCache.list;
  const list = (await call<SonarrSeries[]>("GET", "/series")).map((x) => ({ ...x, instance: "" }));
  const have = new Set(list.map((x) => x.tvdbId));
  const extra = getSettings().sonarrExtra;
  for (let i = 0; i < extra.length; i++) {
    try {
      for (const x of await call<SonarrSeries[]>("GET", "/series", undefined, extra[i])) if (!have.has(x.tvdbId)) list.push({ ...x, instance: extra[i].url });
    } catch (e) {
      console.warn(`Sonarr "${extra[i].name}" unreachable: ${(e as Error).message}`);
    }
  }
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
  /** Seasons TVDB lists for the series, so a hand-matched show can pick its season. */
  seasons: number[];
}

/** Default monitoring for a pick: a sequel the user doesn't own gets only its season; anything unclear gets "future". */
function defaultMonitor(season: number | null, cfg = getSettings().sonarr, firstOfMany = false): MonitorChoice {
  if (season === 1) return firstOfMany ? "future" : "all";
  if (season && season > 1) return cfg.sequelMonitor === "newSeason" ? "season" : "all";
  return "future"; // season unknown or specials: never grab a whole back catalogue by surprise
}

const MONITOR_LABEL: Record<MonitorChoice, (s: number | null) => string> = {
  season: (s) => `Season ${s} only`,
  all: () => "All seasons",
  future: () => "Only new episodes from now on",
  none: () => "Nothing (add it unmonitored)",
};

export async function planAdd(tvdbId: number, season: number | null, firstOfMany = false): Promise<AddPlan> {
  const cfg = getSettings().sonarr;
  const [s] = await call<SonarrSeries[]>("GET", `/series/lookup?term=tvdb:${tvdbId}`);
  if (!s) throw new Error(`Sonarr found no series for TVDB ${tvdbId}`);
  const [profiles, tags] = await Promise.all([call<{ id: number; name: string }[]>("GET", "/qualityprofile"), call<{ id: number; label: string }[]>("GET", "/tag")]);
  const monitor = defaultMonitor(season, cfg, firstOfMany);
  const seasonListed = !season || s.seasons.some((x) => x.seasonNumber === season);
  const options: { value: MonitorChoice; label: string }[] = [];
  if (season && season > 1) options.push({ value: "season", label: MONITOR_LABEL.season(season) });
  options.push({ value: "all", label: MONITOR_LABEL.all(null) }, { value: "future", label: MONITOR_LABEL.future(null) }, { value: "none", label: MONITOR_LABEL.none(null) });
  return {
    title: s.title,
    year: (s.year as number | undefined) ?? null,
    monitor,
    monitorLabel: MONITOR_LABEL[monitor](season),
    season,
    seasonListed,
    // Mirrors addSeries: Sonarr only searches when there's something listed to search for.
    search: cfg.searchOnAdd && (monitor === "all" || (monitor === "season" && seasonListed)),
    profile: profiles.find((p) => p.id === cfg.qualityProfileId)?.name ?? null,
    rootFolder: cfg.rootFolderPath,
    tags: [...tags.filter((t) => cfg.tags.includes(t.id)).map((t) => t.label), "tastearr"],
    options,
    seasons: s.seasons.map((x) => x.seasonNumber).filter((n) => n > 0),
  };
}

/** Sonarr's own title search: the fallback when the community AniList -> TVDB list hasn't caught up yet. */
export async function lookupByTitle(titles: string[], year: number | null = null) {
  const seen = new Map<number, { tvdbId: number; title: string; year: number | null; network: string | null; seasons: number[]; overview: string | null; inLibrary: boolean; confident: boolean; rank: number }>();
  const owned = new Set((await sonarrSeries().catch(() => [] as SonarrSeries[])).map((x) => x.tvdbId));
  const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const want = words(titles.join(" "));
  for (const t of titles.filter(Boolean).slice(0, 2)) {
    for (const x of (await call<SonarrSeries[]>("GET", `/series/lookup?term=${encodeURIComponent(t)}`)).slice(0, 6)) {
      if (!x.tvdbId || seen.has(x.tvdbId)) continue;
      const y = (x.year as number | undefined) || null;
      const have = words(x.title);
      // Shared words over the longer of the two titles, so "Dark Blue" doesn't look like a match for a long title.
      const shared = [...have].filter((w) => want.has(w)).length;
      const overlap = shared / Math.max(1, have.size, Math.min(want.size, 8));
      // Best guess first: title overlap, a little extra when it's a series already in Sonarr (a new season of something
      // owned) and still a close title, then a plausible year (a series can't start after the show we're matching).
      const rank = overlap * 2 + (owned.has(x.tvdbId) && overlap >= 0.5 ? 0.5 : 0) + (year && y ? (Math.abs(year - y) <= 1 ? 0.5 : y > year ? -1 : 0) : 0);
      seen.set(x.tvdbId, {
        tvdbId: x.tvdbId,
        title: x.title,
        year: y,
        network: (x.network as string | undefined) ?? null,
        seasons: x.seasons.map((z) => z.seasonNumber).filter((n) => n > 0),
        overview: ((x.overview as string | undefined) ?? "").slice(0, 200) || null,
        inLibrary: owned.has(x.tvdbId),
        // Half the words in common or more: worth offering as "Is this it?". Below that, just list them.
        confident: overlap >= 0.5 && (shared >= 2 || have.size === 1),
        rank,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.rank - a.rank).map(({ rank: _r, ...c }) => c);
}

/**
 * Adds a show to Sonarr as an anime series with the chosen monitoring. The default (see defaultMonitor) never
 * downloads a back catalogue the user didn't ask for: sequels get only their season, unclear cases only new episodes.
 */
export async function addSeries(tvdbId: number, season: number | null, opts: { monitor?: MonitorChoice; search?: boolean; firstOfMany?: boolean } = {}) {
  const cfg = getSettings().sonarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw new Error("Pick a quality profile and root folder in Settings first");
  const [s] = await call<SonarrSeries[]>("GET", `/series/lookup?term=tvdb:${tvdbId}`);
  if (!s) throw new Error(`Sonarr found no series for TVDB ${tvdbId}`);
  let monitor = opts.monitor ?? defaultMonitor(season, cfg, opts.firstOfMany);
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

export async function setMonitored(seriesId: number, monitored: boolean, instance = "") {
  const c = connOf(instance);
  const full = await call<SonarrSeries>("GET", `/series/${seriesId}`, undefined, c);
  await call("PUT", `/series/${seriesId}`, { ...full, monitored }, c);
  seriesCache = null;
}

/** Whether monitoring a season would also switch an unmonitored series back on (shown in the confirm dialog). */
export async function seriesMonitored(tvdbId: number) {
  return (await sonarrSeries()).find((x) => x.tvdbId === tvdbId)?.monitored ?? null;
}

/** Monitors one season of a series that's already in Sonarr (refreshing it first if TVDB is newer) and searches for it. */
export async function monitorSeason(tvdbId: number, season: number, search = getSettings().sonarr.searchOnAdd) {
  const s = (await sonarrSeries(true)).find((x) => x.tvdbId === tvdbId);
  if (!s) throw new Error("Series is not in Sonarr");
  const c = connOf(s.instance);
  let full = await call<SonarrSeries>("GET", `/series/${s.id}`, undefined, c);
  if (!full.seasons.some((x) => x.seasonNumber === season)) {
    const cmd = await call<{ id: number }>("POST", "/command", { name: "RefreshSeries", seriesId: s.id }, c);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await call<{ status: string }>("GET", `/command/${cmd.id}`, undefined, c);
      if (st.status === "completed" || st.status === "failed") break;
    }
    full = await call<SonarrSeries>("GET", `/series/${s.id}`, undefined, c);
  }
  const target = full.seasons.find((x) => x.seasonNumber === season);
  // Series-level monitoring is what makes Sonarr grab new episodes; the preview tells the user when this flips it back on.
  const resumed = !full.monitored;
  full.monitored = true;
  if (target) target.monitored = true;
  else full.monitorNewItems = "all"; // TVDB hasn't listed it yet; Sonarr monitors it when it appears
  await call("PUT", `/series/${s.id}`, full, c);
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  if (target && search) await call("POST", "/command", { name: "SeasonSearch", seriesId: s.id, seasonNumber: season }, c);
  seriesCache = null;
  return { id: s.id, title: s.title, season, waitingForSeason: !target, resumedSeries: resumed };
}
