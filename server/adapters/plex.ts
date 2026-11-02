import { eachLimit, SEASON_CONCURRENCY } from "../core/concurrency.js";
import { checkOutbound } from "../core/outbound.js";
import type { WatchState } from "../core/taste/types.js";

/** A Plex Media Server (libraries, watch progress) and plex.tv ("Sign in with Plex", the account's servers). */

export interface PlexConn {
  url: string;
  token: string;
}

async function plexGet<T>(conn: PlexConn, path: string): Promise<T> {
  checkOutbound(conn.url, "The media server address");
  const res = await fetch(`${conn.url}${path}`, {
    headers: { Accept: "application/json", "X-Plex-Token": conn.token },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Plex ${path.split("?")[0]} failed (HTTP ${res.status})`);
  return ((await res.json()) as { MediaContainer: T }).MediaContainer;
}

export async function plexInfo(conn: PlexConn) {
  const d = await plexGet<{ friendlyName: string; version: string }>(conn, "/");
  return { name: d.friendlyName, version: d.version };
}

/** Show libraries. */
export async function plexLibraries(conn: PlexConn) {
  const d = await plexGet<{ Directory?: { key: string; type: string; title: string }[] }>(conn, "/library/sections");
  return (d.Directory ?? []).filter((x) => x.type === "show").map((x) => ({ id: x.key, title: x.title }));
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

/** Watch progress per TVDB id in the given libraries; per-season detail only for shows with some progress. */
export async function plexWatchStates(conn: PlexConn, libs: string[], tvdbByAnidb: Map<number, number>) {
  const out = new Map<number, WatchState>();
  type PlexShow = {
    ratingKey: string;
    title: string;
    guid?: string;
    Guid?: { id: string }[];
    leafCount?: number;
    viewedLeafCount?: number;
    userRating?: number;
  };
  const detail: { key: string; state: WatchState }[] = [];
  for (const lib of libs) {
    const d = await plexGet<{ Metadata?: PlexShow[] }>(conn, `/library/sections/${encodeURIComponent(lib)}/all?type=2&includeGuids=1`);
    for (const s of d.Metadata ?? []) {
      const tvdb = plexTvdb(s, tvdbByAnidb);
      if (!tvdb) continue;
      const state: WatchState = {
        title: s.title,
        watched: s.viewedLeafCount ?? 0,
        total: s.leafCount ?? 0,
        seasons: new Map(),
        rating: s.userRating ?? null,
      };
      // Per-season detail only for shows with some progress (one request each, a few at a time).
      if (state.watched > 0) detail.push({ key: s.ratingKey, state });
      out.set(tvdb, state);
    }
  }
  await eachLimit(detail, SEASON_CONCURRENCY, async ({ key, state }) => {
    const c = await plexGet<{ Metadata?: { index: number; leafCount?: number; viewedLeafCount?: number }[] }>(
      conn,
      `/library/metadata/${encodeURIComponent(key)}/children`,
    ).catch(() => ({ Metadata: [] }));
    for (const x of c.Metadata ?? []) state.seasons.set(x.index, { watched: x.viewedLeafCount ?? 0, total: x.leafCount ?? 0 });
  });
  return out;
}

// --- "Sign in with Plex" (PIN flow). Gives Tastearr its own revocable device token instead of reusing the owner's.

const PLEX_TV = "https://plex.tv/api/v2";

function plexHeaders(clientId: string, token?: string) {
  const h: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Product": "Tastearr",
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Device-Name": "Tastearr",
  };
  if (token) h["X-Plex-Token"] = token;
  return h;
}

export async function plexCreatePin(clientId: string) {
  const res = await fetch(`${PLEX_TV}/pins?strong=true`, {
    method: "POST",
    headers: plexHeaders(clientId),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`plex.tv ${res.status}`);
  const pin = (await res.json()) as { id: number; code: string };
  const params = new URLSearchParams({ clientID: clientId, code: pin.code, "context[device][product]": "Tastearr" });
  return { id: pin.id, authUrl: `https://app.plex.tv/auth#?${params}` };
}

export async function plexCheckPin(clientId: string, id: number): Promise<string | null> {
  const res = await fetch(`${PLEX_TV}/pins/${id}`, { headers: plexHeaders(clientId), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`plex.tv ${res.status}`);
  return ((await res.json()) as { authToken: string | null }).authToken;
}

/** Servers the signed-in account can reach, with their connection URLs and server-scoped access tokens. */
export async function plexServers(clientId: string, accountToken: string) {
  const res = await fetch(`${PLEX_TV}/resources?includeHttps=1`, {
    headers: plexHeaders(clientId, accountToken),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`plex.tv ${res.status}`);
  type Conn = { uri: string; address: string; port: number; local: boolean; relay: boolean };
  const list = (await res.json()) as {
    name: string;
    clientIdentifier: string;
    provides: string;
    owned: boolean;
    accessToken: string;
    connections: Conn[];
  }[];
  return list
    .filter((r) => r.provides.split(",").includes("server"))
    .map((r) => {
      const conns = r.connections.filter((c) => !c.relay).sort((a, b) => Number(b.local) - Number(a.local));
      // Plain http://ip:port for LAN addresses first: plex.direct names often fail behind DNS-rebind protection.
      const urls = [...new Set([...conns.filter((c) => c.local).map((c) => `http://${c.address}:${c.port}`), ...conns.map((c) => c.uri)])];
      return { id: r.clientIdentifier, name: r.name, owned: r.owned, accessToken: r.accessToken, urls };
    });
}
