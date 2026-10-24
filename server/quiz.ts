import { db } from "./db.js";
import { allGenres, getPopular, type Media } from "./anilist.js";
import { getSettings } from "./settings.js";
import { features, title } from "./taste.js";

/**
 * Cold-start quiz: well-known shows picked so that together they cover as many different genres/tags as
 * possible, so each answer teaches the model something new.
 */
const QUIZ_SIZE = 30;
let pool: { at: number; list: Media[] } | null = null;

async function getPool() {
  if (!pool || Date.now() - pool.at > 7 * 86_400_000) pool = { at: Date.now(), list: await getPopular(4) };
  return pool.list;
}

export async function getQuiz() {
  const answers = new Map((db.prepare("SELECT anilist_id, verdict FROM feedback WHERE source = 'quiz'").all() as { anilist_id: number; verdict: string }[]).map((r) => [r.anilist_id, r.verdict]));
  const list = (await getPool()).filter((m) => m.countryOfOrigin === "JP");
  const minRank = getSettings().training.minTagRank;

  const covered = new Map<string, number>();
  const chosen: Media[] = [];
  const rest = [...list];
  while (chosen.length < QUIZ_SIZE && rest.length) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    rest.forEach((m, i) => {
      const feats = features(m, minRank);
      const novelty = feats.reduce((a, f) => a + 1 / (1 + (covered.get(f) ?? 0)), 0);
      const fame = Math.log10(m.popularity) / 2;
      if (novelty + fame > bestScore) [bestScore, bestIdx] = [novelty + fame, i];
    });
    const [m] = rest.splice(bestIdx, 1);
    chosen.push(m);
    for (const f of features(m, minRank)) covered.set(f, (covered.get(f) ?? 0) + 1);
  }
  // Keep already-answered shows in the quiz even if the pool shifted.
  for (const id of answers.keys()) if (!chosen.some((m) => m.id === id)) {
    const m = list.find((x) => x.id === id);
    if (m) chosen.push(m);
  }

  return {
    genres: allGenres(),
    genrePrefs: getSettings().genrePrefs,
    shows: chosen.map((m) => ({ id: m.id, title: title(m), cover: m.coverImage.large, color: m.coverImage.color, year: m.seasonYear, genres: m.genres, answer: answers.get(m.id) ?? null })),
  };
}
