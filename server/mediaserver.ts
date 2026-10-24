import { getSettings, type Settings } from "./settings.js";

/** How far the user got through a show, keyed by TVDB id. */
export interface WatchState { title: string; watched: number; total: number }

type MediaConn = Settings["media"];

async function plexGet<T>(conn: MediaConn, path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${conn.url}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Plex ${path.split("?")[0]}: ${res.status}`);
  return ((await res.json()) as { MediaContainer: T }).MediaContainer;
}

async function jfGet<T>(conn: MediaConn, path: string): Promise<T> {
  const res = await fetch(`${conn.url}${path}`, { headers: { "X-Emby-Token": conn.token, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Jellyfin ${path.split("?")[0]}: ${res.status}`);
  return (await res.json()) as T;
}

export interface Library { id: string; title: string }

/** Show libraries on the configured (or given) media server. */
export async function listLibraries(conn: MediaConn = getSettings().media): Promise<Library[]> {
  if (conn.type === "plex") {
    const d = await plexGet<{ Directory?: { key: string; type: string; title: string }[] }>(conn, "/library/sections");
    return (d.Directory ?? []).filter((x) => x.type === "show").map((x) => ({ id: x.key, title: x.title }));
  }
  if (conn.type === "jellyfin") {
    const d = await jfGet<{ Items: { Id: string; Name: string; CollectionType?: string }[] }>(conn, `/Users/${conn.userId}/Views`);
    return d.Items.filter((x) => x.CollectionType === "tvshows").map((x) => ({ id: x.Id, title: x.Name }));
  }
  return [];
}

export async function listJellyfinUsers(conn: MediaConn) {
  const d = await jfGet<{ Id: string; Name: string }[]>(conn, "/Users");
  return d.map((u) => ({ id: u.Id, name: u.Name }));
}

export async function testMediaServer(conn: MediaConn) {
  if (conn.type === "plex") {
    const d = await plexGet<{ friendlyName: string; version: string }>(conn, "/");
    return { name: d.friendlyName, version: d.version };
  }
  if (conn.type === "jellyfin") {
    const d = await jfGet<{ ServerName: string; Version: string }>(conn, "/System/Info");
    return { name: d.ServerName, version: d.Version };
  }
  throw new Error("No media server selected");
}

export async function watchStates(): Promise<Map<number, WatchState>> {
  const conn = getSettings().media;
  const out = new Map<number, WatchState>();
  if (conn.type === "none" || !conn.url || !conn.token) return out;
  const libs = conn.libraryIds.length ? conn.libraryIds : (await listLibraries(conn)).map((l) => l.id);

  if (conn.type === "plex") {
    for (const lib of libs) {
      const d = await plexGet<{ Metadata?: { title: string; leafCount?: number; viewedLeafCount?: number; Guid?: { id: string }[] }[] }>(
        conn,
        `/library/sections/${lib}/all?type=2&includeGuids=1`,
      );
      for (const s of d.Metadata ?? []) {
        const tvdb = Number(s.Guid?.find((g) => g.id.startsWith("tvdb://"))?.id.slice(7));
        if (tvdb) out.set(tvdb, { title: s.title, watched: s.viewedLeafCount ?? 0, total: s.leafCount ?? 0 });
      }
    }
  } else if (conn.type === "jellyfin") {
    for (const lib of libs) {
      const d = await jfGet<{ Items: { Name: string; ProviderIds?: Record<string, string>; RecursiveItemCount?: number; UserData?: { UnplayedItemCount?: number } }[] }>(
        conn,
        `/Users/${conn.userId}/Items?ParentId=${lib}&IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,RecursiveItemCount`,
      );
      for (const s of d.Items) {
        const tvdb = Number(s.ProviderIds?.Tvdb);
        const total = s.RecursiveItemCount ?? 0;
        if (tvdb) out.set(tvdb, { title: s.Name, watched: Math.max(0, total - (s.UserData?.UnplayedItemCount ?? total)), total });
      }
    }
  }
  return out;
}
