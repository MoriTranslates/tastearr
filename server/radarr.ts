import { getSettings, type Settings } from "./settings.js";

export interface RadarrMovie { id: number; tmdbId: number; title: string; hasFile: boolean; monitored: boolean; [k: string]: unknown }

type Conn = Pick<Settings["radarr"], "url" | "apiKey">;

async function call<T>(method: string, path: string, body?: unknown, conn: Conn = getSettings().radarr): Promise<T> {
  if (!conn.url || !conn.apiKey) throw new Error("Radarr is not configured");
  if (!/^https?:\/\//i.test(conn.url)) throw new Error("Radarr URL must start with http:// or https://");
  const res = await fetch(`${conn.url}/api/v3${path}`, {
    method,
    headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Radarr ${method} ${path.split("?")[0]} failed (HTTP ${res.status})`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const radarrConfigured = () => !!(getSettings().radarr.url && getSettings().radarr.apiKey);

export async function testRadarr(conn: Conn) {
  const s = await call<{ version: string; appName?: string }>("GET", "/system/status", undefined, conn);
  if (s.appName && s.appName !== "Radarr") throw new Error(`That's ${s.appName}, not Radarr`);
  return { version: s.version };
}

export async function radarrOptions(conn: Conn = getSettings().radarr) {
  const [profiles, roots, tags] = await Promise.all([
    call<{ id: number; name: string }[]>("GET", "/qualityprofile", undefined, conn),
    call<{ id: number; path: string }[]>("GET", "/rootfolder", undefined, conn),
    call<{ id: number; label: string }[]>("GET", "/tag", undefined, conn),
  ]);
  return { profiles: profiles.map(({ id, name }) => ({ id, name })), roots: roots.map(({ id, path }) => ({ id, path })), tags };
}

let cache: { at: number; list: RadarrMovie[] } | null = null;

export async function radarrMovies(force = false): Promise<RadarrMovie[]> {
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.list;
  const list = await call<RadarrMovie[]>("GET", "/movie");
  cache = { at: Date.now(), list };
  return list;
}

/** Adds a movie by TMDB id, or by IMDb id when the community mapping has no TMDB id for it. */
export async function addMovie(ids: { tmdbId?: number | null; imdbId?: string | null }) {
  const cfg = getSettings().radarr;
  if (!cfg.qualityProfileId || !cfg.rootFolderPath) throw new Error("Pick a Radarr quality profile and root folder in Settings first");
  const m = ids.tmdbId
    ? await call<RadarrMovie>("GET", `/movie/lookup/tmdb?tmdbId=${ids.tmdbId}`)
    : ids.imdbId && /^tt\d+$/.test(ids.imdbId)
      ? await call<RadarrMovie>("GET", `/movie/lookup/imdb?imdbId=${ids.imdbId}`)
      : null;
  if (!m?.tmdbId) throw new Error("Radarr couldn't find this movie");
  let tag: number | null = null;
  try {
    const tags = await call<{ id: number; label: string }[]>("GET", "/tag");
    tag = (tags.find((t) => t.label === "tastearr") ?? (await call<{ id: number }>("POST", "/tag", { label: "tastearr" }))).id;
  } catch {
    /* tagging is best-effort */
  }
  const added = await call<RadarrMovie>("POST", "/movie", {
    ...m,
    qualityProfileId: cfg.qualityProfileId,
    rootFolderPath: cfg.rootFolderPath,
    minimumAvailability: cfg.minimumAvailability,
    monitored: true,
    tags: [...new Set([...cfg.tags, ...(tag ? [tag] : [])])],
    addOptions: { searchForMovie: cfg.searchOnAdd },
  });
  cache = null;
  return { id: added.id, title: added.title };
}
