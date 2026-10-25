import { mappingTables } from "./mapping.js";
import { getSettings, type Settings } from "./settings.js";

/** How far the user got through a show, keyed by TVDB id, with per-season detail when available. */
export interface WatchState {
  title: string;
  watched: number;
  total: number;
  seasons: Map<number, { watched: number; total: number }>;
  /** Explicit rating 0-10 (Plex userRating, Jellyfin favourite = 10), if any. */
  rating: number | null;
}

type MediaConn = Settings["media"];

function checkUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Server URL must start with http:// or https://");
}

async function plexGet<T>(conn: MediaConn, path: string): Promise<T> {
  checkUrl(conn.url);
  const res = await fetch(`${conn.url}${path}`, {
    headers: { Accept: "application/json", "X-Plex-Token": conn.token },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Plex ${path.split("?")[0]} failed (HTTP ${res.status})`);
  return ((await res.json()) as { MediaContainer: T }).MediaContainer;
}

async function jfGet<T>(conn: MediaConn, path: string): Promise<T> {
  checkUrl(conn.url);
  const res = await fetch(`${conn.url}${path}`, { headers: { "X-Emby-Token": conn.token, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Jellyfin ${path.split("?")[0]} failed (HTTP ${res.status})`);
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
    if (!conn.userId) throw new Error("Pick a Jellyfin user first");
    const d = await jfGet<{ Items: { Id: string; Name: string; CollectionType?: string }[] }>(conn, `/Users/${encodeURIComponent(conn.userId)}/Views`);
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

/** TVDB id from the new Plex agent's Guid list, the legacy TheTVDB agent, or HAMA (tvdb-N or anidb-N). */
function plexTvdb(s: { guid?: string; Guid?: { id: string }[] }, tvdbByAnidb: Map<number, number>) {
  const fromList = s.Guid?.find((g) => g.id.startsWith("tvdb://"))?.id.slice(7);
  if (fromList) return Number(fromList);
  const legacy = s.guid?.match(/(?:thetvdb:\/\/|tvdb\d?-)(\d+)/);
  if (legacy) return Number(legacy[1]);
  const anidb = s.guid?.match(/anidb\d?-(\d+)/);
  return anidb ? (tvdbByAnidb.get(Number(anidb[1])) ?? 0) : 0;
}

export async function watchStates(): Promise<Map<number, WatchState>> {
  const conn = getSettings().media;
  const out = new Map<number, WatchState>();
  if (conn.type === "none" || !conn.url || !conn.token) return out;
  const libs = conn.libraryIds.length ? conn.libraryIds : (await listLibraries(conn)).map((l) => l.id);

  if (conn.type === "plex") {
    const { tvdbByAnidb } = await mappingTables();
    type PlexShow = { ratingKey: string; title: string; guid?: string; Guid?: { id: string }[]; leafCount?: number; viewedLeafCount?: number; userRating?: number };
    for (const lib of libs) {
      const d = await plexGet<{ Metadata?: PlexShow[] }>(conn, `/library/sections/${encodeURIComponent(lib)}/all?type=2&includeGuids=1`);
      for (const s of d.Metadata ?? []) {
        const tvdb = plexTvdb(s, tvdbByAnidb);
        if (!tvdb) continue;
        const state: WatchState = { title: s.title, watched: s.viewedLeafCount ?? 0, total: s.leafCount ?? 0, seasons: new Map(), rating: s.userRating ?? null };
        // Per-season detail only for shows with some progress (one request each).
        if (state.watched > 0) {
          const c = await plexGet<{ Metadata?: { index: number; leafCount?: number; viewedLeafCount?: number }[] }>(conn, `/library/metadata/${s.ratingKey}/children`).catch(() => ({ Metadata: [] }));
          for (const x of c.Metadata ?? []) state.seasons.set(x.index, { watched: x.viewedLeafCount ?? 0, total: x.leafCount ?? 0 });
        }
        out.set(tvdb, state);
      }
    }
  } else if (conn.type === "jellyfin") {
    if (!conn.userId) throw new Error("Pick a Jellyfin user in Settings");
    const u = encodeURIComponent(conn.userId);
    type JfItem = { Id: string; Name: string; IndexNumber?: number; ProviderIds?: Record<string, string>; RecursiveItemCount?: number; ChildCount?: number; UserData?: { UnplayedItemCount?: number; IsFavorite?: boolean; Rating?: number } };
    for (const lib of libs) {
      const d = await jfGet<{ Items: JfItem[] }>(conn, `/Users/${u}/Items?ParentId=${encodeURIComponent(lib)}&IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,RecursiveItemCount`);
      for (const s of d.Items) {
        const tvdb = Number(s.ProviderIds?.Tvdb);
        if (!tvdb) continue;
        const total = s.RecursiveItemCount ?? 0;
        const watched = Math.max(0, total - (s.UserData?.UnplayedItemCount ?? total));
        const state: WatchState = { title: s.Name, watched, total, seasons: new Map(), rating: s.UserData?.IsFavorite ? 10 : (s.UserData?.Rating ?? null) };
        if (watched > 0) {
          const seasons = await jfGet<{ Items: JfItem[] }>(conn, `/Shows/${s.Id}/Seasons?userId=${u}&Fields=RecursiveItemCount`).catch(() => ({ Items: [] }));
          for (const x of seasons.Items) {
            if (x.IndexNumber === undefined) continue;
            const t = x.RecursiveItemCount ?? x.ChildCount ?? 0;
            state.seasons.set(x.IndexNumber, { watched: Math.max(0, t - (x.UserData?.UnplayedItemCount ?? t)), total: t });
          }
        }
        out.set(tvdb, state);
      }
    }
  }
  return out;
}

// --- "Sign in with Plex" (PIN flow). Gives Tastearr its own revocable device token instead of reusing the owner's.

const PLEX_TV = "https://plex.tv/api/v2";

function plexHeaders(token?: string) {
  const h: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Product": "Tastearr",
    "X-Plex-Client-Identifier": getSettings().plexClientId,
    "X-Plex-Device-Name": "Tastearr",
  };
  if (token) h["X-Plex-Token"] = token;
  return h;
}

export async function plexCreatePin() {
  const res = await fetch(`${PLEX_TV}/pins?strong=true`, { method: "POST", headers: plexHeaders(), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`plex.tv ${res.status}`);
  const pin = (await res.json()) as { id: number; code: string };
  const params = new URLSearchParams({ clientID: getSettings().plexClientId, code: pin.code, "context[device][product]": "Tastearr" });
  return { id: pin.id, authUrl: `https://app.plex.tv/auth#?${params}` };
}

export async function plexCheckPin(id: number): Promise<string | null> {
  const res = await fetch(`${PLEX_TV}/pins/${id}`, { headers: plexHeaders(), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`plex.tv ${res.status}`);
  return ((await res.json()) as { authToken: string | null }).authToken;
}

/** Servers the signed-in account can reach, with their connection URLs and server-scoped access tokens. */
export async function plexServers(accountToken: string) {
  const res = await fetch(`${PLEX_TV}/resources?includeHttps=1`, { headers: plexHeaders(accountToken), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`plex.tv ${res.status}`);
  type Conn = { uri: string; address: string; port: number; local: boolean; relay: boolean };
  const list = (await res.json()) as { name: string; clientIdentifier: string; provides: string; owned: boolean; accessToken: string; connections: Conn[] }[];
  return list
    .filter((r) => r.provides.split(",").includes("server"))
    .map((r) => {
      const conns = r.connections.filter((c) => !c.relay).sort((a, b) => Number(b.local) - Number(a.local));
      // Plain http://ip:port for LAN addresses first: plex.direct names often fail behind DNS-rebind protection.
      const urls = [...new Set([...conns.filter((c) => c.local).map((c) => `http://${c.address}:${c.port}`), ...conns.map((c) => c.uri)])];
      return { id: r.clientIdentifier, name: r.name, owned: r.owned, accessToken: r.accessToken, urls };
    });
}
