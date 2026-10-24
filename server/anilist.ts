import { db } from "./db.js";

export type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";
export const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];

export interface Media {
  id: number;
  title: { romaji: string | null; english: string | null };
  format: string | null;
  status: string | null;
  episodes: number | null;
  season: Season | null;
  seasonYear: number | null;
  countryOfOrigin: string | null;
  isAdult: boolean;
  popularity: number;
  averageScore: number | null;
  genres: string[];
  tags: { name: string; rank: number; isGeneralSpoiler: boolean }[];
  coverImage: { large: string | null; color: string | null };
  description: string | null;
  siteUrl: string;
  studios: { nodes: { name: string }[] };
}

const FIELDS = `id title { romaji english } format status episodes season seasonYear countryOfOrigin isAdult popularity averageScore
  genres tags { name rank isGeneralSpoiler } coverImage { large color } description(asHtml: false) siteUrl studios(isMain: true) { nodes { name } }`;

const ENDPOINT = "https://graphql.anilist.co";
const MIN_GAP_MS = 800; // AniList allows 90 req/min; stay well under it
let last = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Serialised, rate-limited AniList GraphQL call that honours 429 Retry-After. */
function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Tastearr (+https://github.com/MoriTranslates/tastearr)" },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 && attempt < 5) {
        const s = Number(res.headers.get("retry-after")) || 60;
        await new Promise((r) => setTimeout(r, s * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`AniList ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data: T; errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(`AniList: ${body.errors[0].message}`);
      return body.data;
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

type PageResult = { Page: { pageInfo: { hasNextPage: boolean }; media: Media[] } };

function store(list: Media[], season: Season | null, year: number | null) {
  const stmt = db.prepare(
    `INSERT INTO media (id, season, year, data, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at,
       season = COALESCE(excluded.season, media.season), year = COALESCE(excluded.year, media.year)`,
  );
  const now = Date.now();
  for (const m of list) stmt.run(m.id, season, year, JSON.stringify(m), now);
}

export function seasonOf(date = new Date()): { season: Season; year: number } {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function shiftSeason(s: { season: Season; year: number }, by: number) {
  const idx = s.year * 4 + SEASONS.indexOf(s.season) + by;
  return { season: SEASONS[((idx % 4) + 4) % 4], year: Math.floor(idx / 4) };
}

/** Season list from cache, refreshed if stale (current/upcoming: 1 day, past: 30 days). */
export async function getSeason(season: Season, year: number, force = false): Promise<Media[]> {
  const row = db.prepare("SELECT fetched_at FROM season_fetch WHERE season = ? AND year = ?").get(season, year) as { fetched_at: number } | undefined;
  const cur = seasonOf();
  const past = year * 4 + SEASONS.indexOf(season) < cur.year * 4 + SEASONS.indexOf(cur.season);
  const maxAge = (past ? 30 : 1) * 86_400_000;
  if (force || !row || Date.now() - row.fetched_at > maxAge) {
    const all: Media[] = [];
    for (let page = 1; ; page++) {
      const d = await gql<PageResult>(
        `query ($page: Int, $season: MediaSeason, $year: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage }
          media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC) { ${FIELDS} } } }`,
        { page, season, year },
      );
      all.push(...d.Page.media);
      if (!d.Page.pageInfo.hasNextPage || page >= 10) break;
    }
    store(all, season, year);
    db.prepare("INSERT INTO season_fetch (season, year, fetched_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at").run(season, year, Date.now());
  }
  return (db.prepare("SELECT data FROM media WHERE season = ? AND year = ?").all(season, year) as { data: string }[]).map((r) => JSON.parse(r.data));
}

/** Fetches (and caches) arbitrary media by id, e.g. quiz shows and feedback targets. */
export async function getMediaByIds(ids: number[]): Promise<Media[]> {
  const have = new Map<number, Media>();
  for (const id of ids) {
    const r = db.prepare("SELECT data FROM media WHERE id = ?").get(id) as { data: string } | undefined;
    if (r) have.set(id, JSON.parse(r.data));
  }
  const missing = ids.filter((id) => !have.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const d = await gql<PageResult>(`query ($ids: [Int]) { Page(perPage: 50) { pageInfo { hasNextPage } media(id_in: $ids) { ${FIELDS} } } }`, {
      ids: missing.slice(i, i + 50),
    });
    store(d.Page.media, null, null);
    for (const m of d.Page.media) have.set(m.id, m);
  }
  return ids.map((id) => have.get(id)).filter((m): m is Media => !!m);
}

/** Most popular shows overall, used to build the quiz pool. */
export async function getPopular(pages = 4): Promise<Media[]> {
  const all: Media[] = [];
  for (let page = 1; page <= pages; page++) {
    const d = await gql<PageResult>(
      `query ($page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage }
        media(type: ANIME, format_in: [TV, ONA], isAdult: false, sort: POPULARITY_DESC) { ${FIELDS} } } }`,
      { page },
    );
    all.push(...d.Page.media);
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  store(all, null, null);
  return all;
}

export function allGenres(): string[] {
  return ["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"];
}
