import { db } from "./db.js";

export type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";
export const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];

export interface Relation { relationType: string; node: { id: number; type: string; format: string | null } }

export interface Media {
  id: number;
  title: { romaji: string | null; english: string | null; native: string | null };
  format: string | null;
  status: string | null;
  source: string | null;
  episodes: number | null;
  /** Minutes per episode. */
  duration: number | null;
  season: Season | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  countryOfOrigin: string | null;
  isAdult: boolean;
  popularity: number;
  averageScore: number | null;
  genres: string[];
  tags: { name: string; rank: number; isGeneralSpoiler: boolean; isMediaSpoiler: boolean }[];
  coverImage: { large: string | null; color: string | null };
  description: string | null;
  siteUrl: string;
  studios: { nodes: { name: string }[] };
  relations: { edges: Relation[] };
  nextAiringEpisode: { airingAt: number; episode: number } | null;
  externalLinks: { site: string; url: string; type: string | null }[];
  trailer: { id: string; site: string } | null;
}

/** Bump when FIELDS changes so cached rows are refetched. */
export const MEDIA_SCHEMA = 3;

const FIELDS = `id title { romaji english native } format status source episodes duration season seasonYear startDate { year month day }
  countryOfOrigin isAdult popularity averageScore genres tags { name rank isGeneralSpoiler isMediaSpoiler }
  coverImage { large color } description(asHtml: false) siteUrl studios(isMain: true) { nodes { name } }
  relations { edges { relationType node { id type format } } }
  nextAiringEpisode { airingAt episode } externalLinks { site url type } trailer { id site }`;

const ENDPOINT = "https://graphql.anilist.co";
let gapMs = 800; // adjusted from X-RateLimit-Limit (90/min normally, 30/min when AniList is degraded)
let last = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Serialised, rate-limited AniList GraphQL call that honours the rate-limit headers and 429 Retry-After. */
function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const run = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Tastearr (+https://github.com/MoriTranslates/tastearr)" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      const limit = Number(res.headers.get("x-ratelimit-limit"));
      if (limit > 0) gapMs = Math.ceil(60_000 / limit) + 100;
      if (Number(res.headers.get("x-ratelimit-remaining")) === 0) last = Date.now() + 60_000 - gapMs;
      if (res.status === 429 && attempt < 5) {
        const s = Number(res.headers.get("retry-after")) || 60;
        await new Promise((r) => setTimeout(r, s * 1000));
        continue;
      }
      if (res.status >= 500) throw new Error(`AniList is having trouble right now (HTTP ${res.status}). Try again in a few minutes.`);
      if (!res.ok) throw new Error(`AniList refused the request (HTTP ${res.status}): ${(await res.text()).replace(/<[^>]+>/g, " ").trim().slice(0, 160)}`);
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
  for (const m of list) stmt.run(m.id, season, year, JSON.stringify({ ...m, _v: MEDIA_SCHEMA }), now);
}

function parse(data: string): Media | null {
  const m = JSON.parse(data) as Media & { _v?: number };
  return m._v === MEDIA_SCHEMA ? m : null;
}

export function seasonOf(date = new Date()): { season: Season; year: number } {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function shiftSeason(s: { season: Season; year: number }, by: number) {
  const idx = s.year * 4 + SEASONS.indexOf(s.season) + by;
  return { season: SEASONS[((idx % 4) + 4) % 4], year: Math.floor(idx / 4) };
}

/** Season list from cache, refreshed if stale (current/upcoming: 12 hours, past: 30 days). */
export async function getSeason(season: Season, year: number, force = false): Promise<Media[]> {
  const row = db.prepare("SELECT fetched_at FROM season_fetch WHERE season = ? AND year = ?").get(season, year) as { fetched_at: number } | undefined;
  const cur = seasonOf();
  const past = year * 4 + SEASONS.indexOf(season) < cur.year * 4 + SEASONS.indexOf(cur.season);
  const maxAge = past ? 30 * 86_400_000 : 12 * 3_600_000;
  const cached = () => (db.prepare("SELECT data FROM media WHERE season = ? AND year = ?").all(season, year) as { data: string }[]).map((r) => parse(r.data));
  if (!force && row && Date.now() - row.fetched_at <= maxAge) {
    const list = cached();
    if (list.every(Boolean)) return list as Media[];
  }
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
  const unique = [...new Map(all.map((m) => [m.id, m])).values()];
  store(unique, season, year);
  // Shows AniList moved out of this season (or deleted) must not keep the old tag, or the cache never validates.
  if (unique.length) db.prepare(`UPDATE media SET season = NULL, year = NULL WHERE season = ? AND year = ? AND id NOT IN (${unique.map(() => "?").join(",")})`).run(season, year, ...unique.map((m) => m.id));
  db.prepare("INSERT INTO season_fetch (season, year, fetched_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET fetched_at = excluded.fetched_at").run(season, year, Date.now());
  return unique;
}

/** Fetches (and caches) media by id: quiz shows, list imports, prequels, feedback targets. */
export async function getMediaByIds(ids: number[]): Promise<Media[]> {
  const have = new Map<number, Media>();
  const get = db.prepare("SELECT data FROM media WHERE id = ?");
  for (const id of new Set(ids)) {
    const r = get.get(id) as { data: string } | undefined;
    const m = r && parse(r.data);
    if (m) have.set(id, m);
  }
  const missing = [...new Set(ids)].filter((id) => !have.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const d = await gql<PageResult>(`query ($ids: [Int]) { Page(perPage: 50) { pageInfo { hasNextPage } media(id_in: $ids) { ${FIELDS} } } }`, {
      ids: missing.slice(i, i + 50),
    });
    store(d.Page.media, null, null);
    for (const m of d.Page.media) have.set(m.id, m);
  }
  return ids.map((id) => have.get(id)).filter((m): m is Media => !!m);
}

/** Cached media only, never hits the network. */
export function cachedMedia(id: number): Media | null {
  const r = db.prepare("SELECT data FROM media WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? parse(r.data) : null;
}

/** Title search, for the quiz's "add a show you've seen". */
export async function searchTitle(q: string): Promise<Media[]> {
  const d = await gql<PageResult>(
    `query ($q: String) { Page(perPage: 8) { pageInfo { hasNextPage } media(search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH) { ${FIELDS} } } }`,
    { q },
  );
  store(d.Page.media, null, null);
  return d.Page.media;
}

export type PopularFilter = { genre_in?: string[]; tag_in?: string[]; source?: string };

/**
 * Several "popular shows matching X" lists in one request (aliased pages, light fields), for the quiz pool. Tags must
 * rank at least 60% so "Food" doesn't match a show with one cooking scene. Returns ids per filter, oldest-first aware.
 */
export async function popularIdsBatch(filters: PopularFilter[], perPage = 20) {
  const out: { id: number; year: number | null; firstSeason: boolean }[][] = [];
  for (let i = 0; i < filters.length; i += 8) {
    const chunk = filters.slice(i, i + 8);
    const vars: Record<string, unknown> = {};
    const decl: string[] = [];
    const body = chunk.map((f, k) => {
      vars[`g${k}`] = f.genre_in;
      vars[`t${k}`] = f.tag_in;
      vars[`s${k}`] = f.source;
      decl.push(`$g${k}: [String], $t${k}: [String], $s${k}: MediaSource`);
      return `p${k}: Page(perPage: ${perPage}) { media(type: ANIME, format_in: [TV, ONA], isAdult: false, countryOfOrigin: "JP", genre_in: $g${k}, tag_in: $t${k},
        source: $s${k}, minimumTagRank: 60, sort: POPULARITY_DESC) { id startDate { year } relations { edges { relationType node { type } } } } }`;
    });
    const d = await gql<Record<string, { media: { id: number; startDate: { year: number | null } | null; relations: { edges: { relationType: string; node: { type: string } }[] } | null }[] }>>(
      `query (${decl.join(", ")}) { ${body.join(" ")} }`,
      vars,
    );
    for (let k = 0; k < chunk.length; k++)
      out.push(
        (d[`p${k}`]?.media ?? []).map((m) => ({
          id: m.id,
          year: m.startDate?.year ?? null,
          firstSeason: !(m.relations?.edges ?? []).some((e) => (e.relationType === "PREQUEL" || e.relationType === "PARENT") && e.node.type === "ANIME"),
        })),
      );
  }
  return out;
}

export interface ListEntry { mediaId: number; status: string; score: number; progress: number }

/** A user's public AniList anime list. */
export async function anilistUserList(userName: string): Promise<ListEntry[]> {
  const d = await gql<{ MediaListCollection: { lists: { entries: ListEntry[] }[] } }>(
    `query ($u: String) { MediaListCollection(userName: $u, type: ANIME) { lists { entries { mediaId status score(format: POINT_100) progress } } } }`,
    { u: userName },
  );
  return d.MediaListCollection.lists.flatMap((l) => l.entries);
}

/** Episodes of the given shows that aired in a time window (unix seconds). */
export async function airedBetween(ids: number[], from: number, to: number) {
  const out: { mediaId: number; episode: number; airingAt: number }[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    for (let page = 1; page <= 10; page++) {
      const d = await gql<{ Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: { mediaId: number; episode: number; airingAt: number }[] } }>(
        `query ($ids: [Int], $from: Int, $to: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { mediaId episode airingAt } } }`,
        { ids: ids.slice(i, i + 50), from, to, page },
      );
      out.push(...d.Page.airingSchedules);
      if (!d.Page.pageInfo.hasNextPage) break;
    }
  }
  return out;
}

/** AniList genres with a plain-English hint for people new to anime terms. */
export function allGenres(): { key: string; label: string }[] {
  return [
    ["Action", ""], ["Adventure", ""], ["Comedy", ""], ["Drama", ""], ["Ecchi", "fan service, sexy"], ["Fantasy", ""], ["Horror", ""],
    ["Mahou Shoujo", "magical girls"], ["Mecha", "giant robots"], ["Music", ""], ["Mystery", ""], ["Psychological", ""], ["Romance", ""],
    ["Sci-Fi", ""], ["Slice of Life", "everyday life"], ["Sports", ""], ["Supernatural", ""], ["Thriller", ""],
  ].map(([key, hint]) => ({ key, label: hint ? `${key} (${hint})` : key }));
}
