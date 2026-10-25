import { db } from "./db.js";
import { allGenres, searchPopular, type Media } from "./anilist.js";
import { getSettings } from "./settings.js";
import { title } from "./taste.js";

/**
 * Cold-start quiz. Shows are drawn from taste archetypes (isekai power fantasy, game worlds, ecchi/harem,
 * CGDCT, shoujo romance, kids, ...) so a handful of answers separates very different viewers. Only the first
 * season of each franchise is used, and each archetype includes an older pick where possible.
 */
const ARCHETYPES: { key: string; label: string; filter: Parameters<typeof searchPopular>[0] }[] = [
  { key: "isekai", label: "Isekai power fantasy", filter: { tag_in: ["Isekai"], source: "LIGHT_NOVEL" } },
  { key: "game", label: "Game worlds", filter: { tag_in: ["Video Games"] } },
  { key: "ecchi", label: "Ecchi & harem", filter: { genre_in: ["Ecchi"] } },
  { key: "battle", label: "Shounen battle", filter: { tag_in: ["Shounen"], genre_in: ["Action"] } },
  { key: "dark", label: "Dark & psychological", filter: { genre_in: ["Psychological"] } },
  { key: "romcom", label: "Romantic comedy", filter: { tag_in: ["Male Protagonist"], genre_in: ["Romance"] } },
  { key: "shoujo", label: "Shoujo & josei romance", filter: { tag_in: ["Shoujo", "Josei"], genre_in: ["Romance"] } },
  { key: "cgdct", label: "Cute & cozy", filter: { tag_in: ["Cute Girls Doing Cute Things", "Iyashikei"] } },
  { key: "sports", label: "Sports", filter: { genre_in: ["Sports"] } },
  { key: "mecha", label: "Mecha & sci-fi", filter: { genre_in: ["Mecha"] } },
  { key: "horror", label: "Horror", filter: { genre_in: ["Horror"] } },
  { key: "idol", label: "Idols & pretty boys", filter: { tag_in: ["Idol", "Reverse Harem"] } },
  { key: "kids", label: "Kids & family", filter: { tag_in: ["Kids"] } },
  { key: "comedy", label: "Gag comedy", filter: { tag_in: ["Parody", "Surreal Comedy"] } },
];
const PER_ARCHETYPE = 2;
const OLD_BEFORE = 20100000;

let pool: { at: number; shows: { m: Media; archetype: string }[] } | null = null;

const isFirstSeason = (m: Media) => !(m.relations?.edges ?? []).some((e) => (e.relationType === "PREQUEL" || e.relationType === "PARENT") && e.node.type === "ANIME");

async function buildPool() {
  const shows: { m: Media; archetype: string }[] = [];
  const used = new Set<number>();
  for (const a of ARCHETYPES) {
    const recent = (await searchPopular(a.filter, 15)).filter(isFirstSeason);
    const older = (await searchPopular({ ...a.filter, startBefore: OLD_BEFORE }, 8)).filter(isFirstSeason);
    const picks = [older.find((m) => !used.has(m.id)), ...recent.filter((m) => !used.has(m.id))].filter((m): m is Media => !!m);
    for (const m of [...new Map(picks.map((x) => [x.id, x])).values()].slice(0, PER_ARCHETYPE + 1)) {
      used.add(m.id);
      shows.push({ m, archetype: a.label });
    }
  }
  return shows;
}

export async function getQuiz() {
  if (!pool || Date.now() - pool.at > 7 * 86_400_000) pool = { at: Date.now(), shows: await buildPool() };
  const answers = new Map((db.prepare("SELECT anilist_id, verdict FROM feedback WHERE source = 'quiz'").all() as { anilist_id: number; verdict: string }[]).map((r) => [r.anilist_id, r.verdict]));
  return {
    genres: allGenres(),
    genrePrefs: getSettings().genrePrefs,
    shows: pool.shows.map(({ m, archetype }) => ({
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
