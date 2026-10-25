import { db } from "./db.js";
import { allGenres, getMediaByIds, popularIdsBatch, type Media, type PopularFilter } from "./anilist.js";
import { getSettings } from "./settings.js";
import { title } from "./taste.js";

/**
 * Cold-start quiz. Shows are drawn from taste archetypes (isekai power fantasy, game worlds, ecchi/harem,
 * CGDCT, shoujo romance, kids, ...) so a handful of answers separates very different viewers. Only the first
 * season of each franchise is used, and each archetype includes an older pick where possible.
 */
const ARCHETYPES: { key: string; label: string; filter: PopularFilter }[] = [
  { key: "isekai", label: "Transported to another world", filter: { tag_in: ["Isekai"], source: "LIGHT_NOVEL" } },
  { key: "game", label: "Video-game worlds", filter: { tag_in: ["Video Games"] } },
  { key: "adventure", label: "Fantasy adventure", filter: { genre_in: ["Adventure"], tag_in: ["Travel"] } },
  { key: "ecchi", label: "Fan service & harem", filter: { genre_in: ["Ecchi"], tag_in: ["Female Harem"] } },
  { key: "battle", label: "Big battles (shounen)", filter: { tag_in: ["Shounen"], genre_in: ["Action"] } },
  { key: "dark", label: "Dark & psychological", filter: { genre_in: ["Psychological"] } },
  { key: "romcom", label: "Romantic comedy", filter: { tag_in: ["Male Protagonist"], genre_in: ["Romance"] } },
  { key: "shoujo", label: "Romance (shoujo/josei)", filter: { tag_in: ["Female Protagonist"], genre_in: ["Romance", "Drama"] } },
  { key: "cozy", label: "Cute & cozy", filter: { tag_in: ["Cute Girls Doing Cute Things", "Iyashikei"] } },
  { key: "food", label: "Food & cooking", filter: { tag_in: ["Food"] } },
  { key: "sports", label: "Sports", filter: { genre_in: ["Sports"] } },
  { key: "mecha", label: "Robots & sci-fi", filter: { genre_in: ["Mecha"] } },
  { key: "horror", label: "Horror", filter: { genre_in: ["Horror"] } },
  { key: "idol", label: "Idols & pretty boys", filter: { tag_in: ["Idol", "Male Harem"] } },
  { key: "kids", label: "Kids & family", filter: { tag_in: ["Kids"] } },
  { key: "comedy", label: "Silly comedy", filter: { tag_in: ["Parody", "Surreal Comedy"] } },
];

/** Plain-language themes for the quiz, stored as "T:<AniList tag>" preferences next to genres. */
export const THEMES = [
  { key: "T:Isekai", label: "Transported to another world (isekai)" },
  { key: "T:Magic", label: "Magic" },
  { key: "T:Food", label: "Food & cooking" },
  { key: "T:Iyashikei", label: "Relaxing, cozy (iyashikei)" },
  { key: "T:Video Games", label: "Video-game worlds" },
  { key: "T:Female Harem", label: "Harem" },
  { key: "T:Military", label: "Military & war" },
  { key: "T:School", label: "School life" },
  { key: "T:Idol", label: "Idols" },
  { key: "T:Kids", label: "Aimed at kids" },
];
const PER_ARCHETYPE = 2;
const OLD_BEFORE = 2010;
const POOL_KEY = "quizPool";

let pool: { at: number; shows: { m: Media; archetype: string }[] } | null = null;
let building: Promise<void> | null = null;

/**
 * Picks about three shows per archetype: first seasons only, one older classic where there is one. Three AniList
 * requests in all (the lists are batched), and the result is saved, so the quiz opens instantly after the first time.
 */
async function buildPool() {
  const lists = await popularIdsBatch(ARCHETYPES.map((a) => a.filter));
  // An archetype that came back empty (tags too strict) falls back to its genre alone.
  const empty = ARCHETYPES.map((a, i) => (lists[i].some((x) => x.firstSeason) || !a.filter.genre_in ? -1 : i)).filter((i) => i >= 0);
  if (empty.length) {
    const retry = await popularIdsBatch(empty.map((i) => ({ genre_in: ARCHETYPES[i].filter.genre_in })));
    empty.forEach((i, k) => (lists[i] = retry[k]));
  }
  const used = new Set<number>();
  const chosen: { id: number; archetype: string }[] = [];
  ARCHETYPES.forEach((a, i) => {
    const first = lists[i].filter((x) => x.firstSeason && !used.has(x.id));
    const older = first.find((x) => x.year !== null && x.year < OLD_BEFORE);
    for (const x of [...new Map([older, ...first].filter((y): y is (typeof first)[number] => !!y).map((y) => [y.id, y])).values()].slice(0, PER_ARCHETYPE + 1)) {
      used.add(x.id);
      chosen.push({ id: x.id, archetype: a.label });
    }
  });
  const media = new Map((await getMediaByIds(chosen.map((c) => c.id))).map((m) => [m.id, m]));
  pool = { at: Date.now(), shows: chosen.filter((c) => media.has(c.id)).map((c) => ({ m: media.get(c.id)!, archetype: c.archetype })) };
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(POOL_KEY, JSON.stringify({ at: pool.at, shows: chosen }));
}

async function loadPool() {
  if (pool && Date.now() - pool.at < 30 * 86_400_000) return;
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(POOL_KEY) as { value: string } | undefined;
  if (row && !pool) {
    const saved = JSON.parse(row.value) as { at: number; shows: { id: number; archetype: string }[] };
    if (Date.now() - saved.at < 30 * 86_400_000) {
      const media = new Map((await getMediaByIds(saved.shows.map((c) => c.id))).map((m) => [m.id, m]));
      pool = { at: saved.at, shows: saved.shows.filter((c) => media.has(c.id)).map((c) => ({ m: media.get(c.id)!, archetype: c.archetype })) };
      return;
    }
  }
  building ??= buildPool().finally(() => (building = null));
  await building;
}

/** Called at startup on a new install, so the quiz is ready by the time someone reaches it. */
export function prewarmQuiz() {
  void loadPool().catch((e) => console.warn("Quiz prewarm failed:", (e as Error).message));
}

export async function getQuiz() {
  await loadPool();
  const answers = new Map((db.prepare("SELECT anilist_id, verdict FROM feedback WHERE source = 'quiz'").all() as { anilist_id: number; verdict: string }[]).map((r) => [r.anilist_id, r.verdict]));
  // Shows the user added themselves with "Add a show you've seen" come first.
  const inPool = new Set(pool!.shows.map((x) => x.m.id));
  const added = (await getMediaByIds([...answers.keys()].filter((id) => !inPool.has(id)))).map((m) => ({ m, archetype: "Added by you" }));
  const all = [...added, ...pool!.shows];
  return {
    genres: allGenres(),
    themes: THEMES,
    noGore: getSettings().filters.noGore,
    genrePrefs: getSettings().genrePrefs,
    shows: all.map(({ m, archetype }) => ({
      id: m.id,
      title: title(m),
      cover: m.coverImage.large,
      color: m.coverImage.color,
      year: m.seasonYear ?? m.startDate?.year ?? null,
      genres: m.genres,
      archetype,
      answer: answers.get(m.id) ?? null,
    })),
  };
}
