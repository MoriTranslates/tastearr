import { db } from "./db.js";
import { anilistUserList } from "./anilist.js";
import { mappingTables } from "./mapping.js";
import { getSettings } from "./settings.js";

/**
 * Imports a public AniList or MyAnimeList anime list. Statuses are normalised to AniList's
 * (COMPLETED, CURRENT, PLANNING, DROPPED, PAUSED, REPEATING) and scores to 0-100.
 */
export interface ImportResult { source: string; entries: number }

function save(source: string, rows: { id: number; status: string; score: number | null; progress: number | null }[]) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM list_entries WHERE source = ?").run(source);
    const ins = db.prepare("INSERT OR REPLACE INTO list_entries (source, anilist_id, status, score, progress) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(source, r.id, r.status, r.score, r.progress);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export async function importAnilist(user: string): Promise<ImportResult> {
  const entries = await anilistUserList(user);
  save("anilist", entries.map((e) => ({ id: e.mediaId, status: e.status, score: e.score || null, progress: e.progress ?? null })));
  return { source: "anilist", entries: entries.length };
}

const MAL_STATUS: Record<string, string> = { completed: "COMPLETED", watching: "CURRENT", plan_to_watch: "PLANNING", dropped: "DROPPED", on_hold: "PAUSED" };

export async function importMal(user: string, clientId: string): Promise<ImportResult> {
  if (!clientId) throw new Error("MyAnimeList needs a free API client ID (myanimelist.net/apiconfig)");
  const { byMal } = await mappingTables();
  const rows: { id: number; status: string; score: number | null; progress: number | null }[] = [];
  let url: string | null = `https://api.myanimelist.net/v2/users/${encodeURIComponent(user)}/animelist?fields=list_status&limit=1000&nsfw=true`;
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: { "X-MAL-CLIENT-ID": clientId }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) throw new Error(`MyAnimeList user "${user}" not found or list is private`);
    if (!res.ok) throw new Error(`MyAnimeList failed (HTTP ${res.status})`);
    const d = (await res.json()) as { data: { node: { id: number }; list_status: { status: string; score: number; num_episodes_watched: number } }[]; paging?: { next?: string } };
    for (const e of d.data) {
      const id = byMal.get(e.node.id);
      if (id) rows.push({ id, status: MAL_STATUS[e.list_status.status] ?? "PLANNING", score: e.list_status.score ? e.list_status.score * 10 : null, progress: e.list_status.num_episodes_watched });
    }
    url = d.paging?.next ?? null;
  }
  save("mal", rows);
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

export function listEntries() {
  return db.prepare("SELECT source, anilist_id AS id, status, score, progress FROM list_entries").all() as { source: string; id: number; status: string; score: number | null; progress: number | null }[];
}
