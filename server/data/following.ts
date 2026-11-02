import { db } from "./db.js";

/** The follow list (people without Sonarr), and which aired episodes were already announced. */

export function followedIds(): number[] {
  return (db.prepare("SELECT anilist_id FROM following").all() as { anilist_id: number }[]).map((r) => r.anilist_id);
}

/** Follows a show; episodes before `nextEpisode` count as announced, so following doesn't announce old ones. */
export function addFollow(id: number, title: string, nextEpisode: number | null) {
  db.prepare("INSERT INTO following (anilist_id, title, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(id, title, Date.now());
  if (nextEpisode)
    for (let ep = 1; ep < nextEpisode; ep++)
      db.prepare("INSERT OR IGNORE INTO aired_notified (anilist_id, episode) VALUES (?, ?)").run(id, ep);
}

export function removeFollow(id: number) {
  db.prepare("DELETE FROM following WHERE anilist_id = ?").run(id);
}

/** A checker for "was this episode announced already" (one prepared statement for a batch). */
export function announcedChecker() {
  const seen = db.prepare("SELECT 1 FROM aired_notified WHERE anilist_id = ? AND episode = ?");
  return (id: number, episode: number) => !!seen.get(id, episode);
}

export function markAnnounced(id: number, episode: number) {
  db.prepare("INSERT OR IGNORE INTO aired_notified (anilist_id, episode) VALUES (?, ?)").run(id, episode);
}
