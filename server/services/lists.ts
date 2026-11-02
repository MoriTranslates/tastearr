import { anilistUserList } from "../adapters/anilist.js";
import { malUserList } from "../adapters/mal.js";
import { fail } from "../core/errors.js";
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
  if (!clientId) throw fail("MyAnimeList needs a free API client ID (myanimelist.net/apiconfig)", 400);
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

/**
 * Re-imports each configured list on its own: one failing (MAL 401, AniList down) keeps its previously imported
 * entries and doesn't stop the other. Returns what was imported and what failed.
 */
export async function refreshListsDetailed(lists = getSettings().lists) {
  const { anilistUser, malUser, malClientId } = lists;
  const imported: string[] = [];
  const errors: string[] = [];
  const one = async (name: string, run: () => Promise<ImportResult>) => {
    try {
      imported.push(`${(await run()).entries} ${name} entries`);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  if (anilistUser) await one("AniList", () => importAnilist(anilistUser));
  if (malUser && malClientId) await one("MAL", () => importMal(malUser, malClientId));
  return { imported, errors };
}

/** Re-imports whichever lists are configured; throws (after trying every list) when any of them failed. */
export async function refreshLists() {
  const { imported, errors } = await refreshListsDetailed();
  if (errors.length) throw new Error(`${errors.join("; ")}${imported.length ? ` (imported ${imported.join(", ")})` : ""}`);
  return imported;
}
