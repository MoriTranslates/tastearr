import { db } from "./db.js";

/** Verdicts on shows (loved, liked, meh, disliked, hidden, added), from the quiz, the Picks page or auto-add. */

export function allFeedback() {
  return db.prepare("SELECT anilist_id, verdict, source FROM feedback").all() as { anilist_id: number; verdict: string; source: string }[];
}

export function verdicts(): Map<number, string> {
  return new Map(
    (db.prepare("SELECT anilist_id, verdict FROM feedback").all() as { anilist_id: number; verdict: string }[]).map((r) => [
      r.anilist_id,
      r.verdict,
    ]),
  );
}

export function quizAnswers(): Map<number, string> {
  return new Map(
    (db.prepare("SELECT anilist_id, verdict FROM feedback WHERE source = 'quiz'").all() as { anilist_id: number; verdict: string }[]).map(
      (r) => [r.anilist_id, r.verdict],
    ),
  );
}

export function setVerdict(id: number, verdict: string | null, source: string) {
  if (!verdict) db.prepare("DELETE FROM feedback WHERE anilist_id = ?").run(id);
  else
    db.prepare(
      "INSERT INTO feedback (anilist_id, verdict, source, at) VALUES (?, ?, ?, ?) ON CONFLICT(anilist_id) DO UPDATE SET verdict = excluded.verdict, source = excluded.source, at = excluded.at",
    ).run(id, verdict, source, Date.now());
}

/** Shows given a thumbs-up or heart on the Picks page since `since` (for the Sonarr/Radarr import lists). */
export function likedSince(since: number): number[] {
  return (
    db.prepare("SELECT anilist_id FROM feedback WHERE source = 'picks' AND verdict IN ('liked', 'loved') AND at > ?").all(since) as {
      anilist_id: number;
    }[]
  ).map((r) => r.anilist_id);
}
