import { db, transaction } from "./db.js";

/**
 * "New episode" alerts waiting to be sent, one row per series. Kept in SQLite (not only in memory) so a crash, OOM
 * kill or `docker kill` between the webhook and the batch flush doesn't lose them; they are sent on the next start.
 */

export interface EpisodeKey {
  seasonNumber: number;
  episodeNumber: number;
}

export interface PendingAlert<S, E extends EpisodeKey> {
  tvdbId: number;
  series: S;
  episodes: E[];
  firstAt: number;
  dueAt: number;
  rev: number;
  attempts: number;
}

interface Row {
  tvdb_id: number;
  series: string;
  episodes: string;
  first_at: number;
  due_at: number;
  rev: number;
  attempts: number;
}

const key = (e: EpisodeKey) => `${e.seasonNumber}x${e.episodeNumber}`;

function toAlert<S, E extends EpisodeKey>(r: Row): PendingAlert<S, E> {
  return {
    tvdbId: r.tvdb_id,
    series: JSON.parse(r.series) as S,
    episodes: JSON.parse(r.episodes) as E[],
    firstAt: r.first_at,
    dueAt: r.due_at,
    rev: r.rev,
    attempts: r.attempts,
  };
}

/** Adds episodes to a series' batch (a repeated webhook for the same episode is ignored). `due` picks the send time. */
export function queueAlert<S, E extends EpisodeKey>(
  tvdbId: number,
  series: S,
  episodes: E[],
  due: (cur: { firstAt: number; dueAt: number } | null) => number,
): PendingAlert<S, E> {
  return transaction(() => {
    const cur = db.prepare("SELECT * FROM pending_alerts WHERE tvdb_id = ?").get(tvdbId) as Row | undefined;
    const merged = new Map<string, E>();
    for (const e of [...(cur ? (JSON.parse(cur.episodes) as E[]) : []), ...episodes]) if (!merged.has(key(e))) merged.set(key(e), e);
    const firstAt = cur?.first_at ?? Date.now();
    const dueAt = due(cur ? { firstAt: cur.first_at, dueAt: cur.due_at } : null);
    db.prepare(
      `INSERT INTO pending_alerts (tvdb_id, series, episodes, first_at, due_at, rev, attempts) VALUES (?, ?, ?, ?, ?, 0, 0)
       ON CONFLICT(tvdb_id) DO UPDATE SET series = excluded.series, episodes = excluded.episodes, due_at = excluded.due_at,
         rev = pending_alerts.rev + 1`,
    ).run(tvdbId, JSON.stringify(series), JSON.stringify([...merged.values()]), firstAt, dueAt);
    return toAlert<S, E>(db.prepare("SELECT * FROM pending_alerts WHERE tvdb_id = ?").get(tvdbId) as unknown as Row);
  });
}

export function pendingAlert<S, E extends EpisodeKey>(tvdbId: number): PendingAlert<S, E> | null {
  const r = db.prepare("SELECT * FROM pending_alerts WHERE tvdb_id = ?").get(tvdbId) as Row | undefined;
  return r ? toAlert<S, E>(r) : null;
}

export function pendingAlerts<S, E extends EpisodeKey>(): PendingAlert<S, E>[] {
  return (db.prepare("SELECT * FROM pending_alerts ORDER BY due_at").all() as unknown as Row[]).map((r) => toAlert<S, E>(r));
}

/**
 * Removes what was sent. When more episodes arrived while sending (`rev` moved on), only the sent ones are removed and
 * the rest stay queued; returns the batch that is still waiting, if any.
 */
export function completeAlert<S, E extends EpisodeKey>(tvdbId: number, rev: number, sent: EpisodeKey[]): PendingAlert<S, E> | null {
  return transaction(() => {
    const cur = db.prepare("SELECT * FROM pending_alerts WHERE tvdb_id = ?").get(tvdbId) as Row | undefined;
    if (!cur) return null;
    const done = new Set(sent.map(key));
    const rest = (JSON.parse(cur.episodes) as E[]).filter((e) => !done.has(key(e)));
    if (cur.rev === rev || !rest.length) {
      db.prepare("DELETE FROM pending_alerts WHERE tvdb_id = ?").run(tvdbId);
      return null;
    }
    db.prepare("UPDATE pending_alerts SET episodes = ?, attempts = 0 WHERE tvdb_id = ?").run(JSON.stringify(rest), tvdbId);
    return toAlert<S, E>({ ...cur, episodes: JSON.stringify(rest), attempts: 0 });
  });
}

/** Counts a failed send and moves the batch's send time; returns the new attempt count. */
export function failedAlert(tvdbId: number, retryAt: number): number {
  db.prepare("UPDATE pending_alerts SET attempts = attempts + 1, due_at = ? WHERE tvdb_id = ?").run(retryAt, tvdbId);
  return (
    (db.prepare("SELECT attempts FROM pending_alerts WHERE tvdb_id = ?").get(tvdbId) as { attempts: number } | undefined)?.attempts ?? 0
  );
}

export function dropAlert(tvdbId: number) {
  db.prepare("DELETE FROM pending_alerts WHERE tvdb_id = ?").run(tvdbId);
}
