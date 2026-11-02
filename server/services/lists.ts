import { anilistUserList } from "../adapters/anilist.js";
import { malUserList } from "../adapters/mal.js";
import { listEntries, replaceListEntries, type ListRow } from "../data/lists.js";
import { mappingTables } from "./mapping.js";
import { getSettings } from "./settings.js";

/**
 * Imports a public AniList or MyAnimeList anime list. Statuses are normalised to AniList's
 * (COMPLETED, CURRENT, PLANNING, DROPPED, PAUSED, REPEATING) and scores to 0-100.
 */

export { listEntries };

export interface ImportResult {
  source: string;
  entries: number;
}

export async function importAnilist(user: string): Promise<ImportResult> {
  const entries = await anilistUserList(user);
  replaceListEntries(
    "anilist",
    entries.map((e) => ({ id: e.mediaId, status: e.status, score: e.score || null, progress: e.progress ?? null })),
  );
  return { source: "anilist", entries: entries.length };
}

const MAL_STATUS: Record<string, string> = {
  completed: "COMPLETED",
  watching: "CURRENT",
  plan_to_watch: "PLANNING",
  dropped: "DROPPED",
  on_hold: "PAUSED",
};

export async function importMal(user: string, clientId: string): Promise<ImportResult> {
  if (!clientId) throw new Error("MyAnimeList needs a free API client ID (myanimelist.net/apiconfig)");
  const { byMal } = await mappingTables();
  const rows: ListRow[] = [];
  for (const e of await malUserList(user, clientId)) {
    const id = byMal.get(e.malId);
    if (id)
      rows.push({ id, status: MAL_STATUS[e.status] ?? "PLANNING", score: e.score ? e.score * 10 : null, progress: e.episodesWatched });
  }
  replaceListEntries("mal", rows);
  return { source: "mal", entries: rows.length };
}

/** Re-imports whichever lists are configured (called before profile rebuilds). */
export async function refreshLists() {
  const { anilistUser, malUser, malClientId } = getSettings().lists;
  const out: string[] = [];
  if (anilistUser) out.push(`${(await importAnilist(anilistUser)).entries} AniList entries`);
  if (malUser && malClientId) out.push(`${(await importMal(malUser, malClientId)).entries} MAL entries`);
  return out;
}
