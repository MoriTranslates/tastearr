import { db, transaction } from "./db.js";

/** Imported AniList/MAL list entries, keyed by source and AniList id. */

export interface ListRow {
  id: number;
  status: string;
  score: number | null;
  progress: number | null;
}

/** Deletes one source's entries; returns how many were removed. */
export function clearListEntries(source: string) {
  return Number(db.prepare("DELETE FROM list_entries WHERE source = ?").run(source).changes);
}

/** Replaces one source's entries. */
export function replaceListEntries(source: string, rows: ListRow[]) {
  transaction(() => {
    db.prepare("DELETE FROM list_entries WHERE source = ?").run(source);
    const ins = db.prepare("INSERT OR REPLACE INTO list_entries (source, anilist_id, status, score, progress) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) ins.run(source, r.id, r.status, r.score, r.progress);
  });
}

export function listEntries() {
  return db.prepare("SELECT source, anilist_id AS id, status, score, progress FROM list_entries").all() as unknown as (ListRow & {
    source: string;
  })[];
}
