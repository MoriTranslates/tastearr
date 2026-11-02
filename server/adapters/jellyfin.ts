import { eachLimit, SEASON_CONCURRENCY } from "../core/concurrency.js";
import { fail } from "../core/errors.js";
import type { WatchState } from "../core/taste/types.js";
import { safeFetch } from "./net.js";
import { keepMostWatched, tvdbFromIds, type ShowIdTables } from "./showids.js";

/** A Jellyfin (or Emby) server: users, libraries and watch progress. */

export interface JellyfinConn {
  url: string;
  token: string;
  userId: string;
}

async function jfGet<T>(conn: { url: string; token: string }, path: string): Promise<T> {
  const res = await safeFetch(
    `${conn.url}${path}`,
    { headers: { "X-Emby-Token": conn.token, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) },
    "The media server address",
  );
  if (!res.ok) throw new Error(`Jellyfin ${path.split("?")[0]} failed (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export async function jellyfinInfo(conn: JellyfinConn) {
  const d = await jfGet<{ ServerName: string; Version: string }>(conn, "/System/Info");
  return { name: d.ServerName, version: d.Version };
}

export async function jellyfinUsers(conn: JellyfinConn) {
  const d = await jfGet<{ Id: string; Name: string }[]>(conn, "/Users");
  return d.map((u) => ({ id: u.Id, name: u.Name }));
}

/** TV show libraries of the chosen user. */
export async function jellyfinLibraries(conn: JellyfinConn) {
  if (!conn.userId) throw fail("Pick a Jellyfin user first", 400);
  const d = await jfGet<{ Items: { Id: string; Name: string; CollectionType?: string }[] }>(
    conn,
    `/Users/${encodeURIComponent(conn.userId)}/Views`,
  );
  return d.Items.filter((x) => x.CollectionType === "tvshows").map((x) => ({ id: x.Id, title: x.Name }));
}

/** Watch progress per TVDB id in the given libraries; per-season detail only for shows with some progress. */
export async function jellyfinWatchStates(conn: JellyfinConn, libs: string[], idTables: ShowIdTables) {
  const out = new Map<number, WatchState>();
  if (!conn.userId) throw fail("Pick a Jellyfin user in Settings", 400);
  const u = encodeURIComponent(conn.userId);
  type JfItem = {
    Id: string;
    Name: string;
    IndexNumber?: number;
    ProviderIds?: Record<string, string>;
    RecursiveItemCount?: number;
    ChildCount?: number;
    UserData?: { UnplayedItemCount?: number; IsFavorite?: boolean; Rating?: number };
  };
  const detail: { id: string; state: WatchState }[] = [];
  for (const lib of libs) {
    const d = await jfGet<{ Items: JfItem[] }>(
      conn,
      `/Users/${u}/Items?ParentId=${encodeURIComponent(lib)}&IncludeItemTypes=Series&Recursive=true&Fields=ProviderIds,RecursiveItemCount`,
    );
    for (const s of d.Items) {
      // Provider id keys as Jellyfin and its AniDB/AniList plugins write them.
      const p = s.ProviderIds ?? {};
      const tvdb = tvdbFromIds({ tvdb: p.Tvdb, tmdb: p.Tmdb, imdb: p.Imdb, anidb: p.AniDB, anilist: p.AniList }, idTables);
      if (!tvdb) continue;
      const total = s.RecursiveItemCount ?? 0;
      const watched = Math.max(0, total - (s.UserData?.UnplayedItemCount ?? total));
      const state: WatchState = {
        title: s.Name,
        watched,
        total,
        seasons: new Map(),
        rating: s.UserData?.IsFavorite ? 10 : (s.UserData?.Rating ?? null),
      };
      if (keepMostWatched(out, tvdb, state) && watched > 0) detail.push({ id: s.Id, state });
    }
  }
  await eachLimit(detail, SEASON_CONCURRENCY, async ({ id, state }) => {
    const seasons = await jfGet<{ Items: JfItem[] }>(
      conn,
      `/Shows/${encodeURIComponent(id)}/Seasons?userId=${u}&Fields=RecursiveItemCount`,
    ).catch(() => ({ Items: [] }));
    for (const x of seasons.Items) {
      if (x.IndexNumber === undefined) continue;
      const t = x.RecursiveItemCount ?? x.ChildCount ?? 0;
      state.seasons.set(x.IndexNumber, { watched: Math.max(0, t - (x.UserData?.UnplayedItemCount ?? t)), total: t });
    }
  });
  return out;
}
