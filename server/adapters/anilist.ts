import type { Media, Season } from "../core/taste/media.js";

/**
 * AniList GraphQL API: season line-ups, entries by id, title search, quiz pools, users' lists and airing schedules.
 * Every call goes through one serialised, rate-limited queue. Caching is the caller's job (services/catalog.ts).
 */

/** Fields requested for every entry; bump MEDIA_SCHEMA in data/media.ts when this changes. */
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
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Tastearr (+https://github.com/MoriTranslates/tastearr)",
        },
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
      if (!res.ok)
        throw new Error(
          `AniList refused the request (HTTP ${res.status}): ${(await res.text())
            .replace(/<[^>]+>/g, " ")
            .trim()
            .slice(0, 160)}`,
        );
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

/** A season's whole line-up, most popular first (up to 10 pages of 50), without duplicates. */
export async function fetchSeason(season: Season, year: number): Promise<Media[]> {
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
  return [...new Map(all.map((m) => [m.id, m])).values()];
}

/** Up to 50 entries by id (one request). */
export async function fetchByIds(ids: number[]): Promise<Media[]> {
  const d = await gql<PageResult>(
    `query ($ids: [Int]) { Page(perPage: 50) { pageInfo { hasNextPage } media(id_in: $ids) { ${FIELDS} } } }`,
    {
      ids,
    },
  );
  return d.Page.media;
}

/** Title search, for the quiz's "add a show you've seen". */
export async function searchTitle(q: string): Promise<Media[]> {
  const d = await gql<PageResult>(
    `query ($q: String) { Page(perPage: 8) { pageInfo { hasNextPage } media(search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH) { ${FIELDS} } } }`,
    { q },
  );
  return d.Page.media;
}

export type PopularFilter = { genre_in?: string[]; tag_in?: string[]; source?: string; minRank?: number };

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
      vars[`r${k}`] = f.minRank ?? 60;
      decl.push(`$g${k}: [String], $t${k}: [String], $s${k}: MediaSource, $r${k}: Int`);
      return `p${k}: Page(perPage: ${perPage}) { media(type: ANIME, format_in: [TV, ONA], isAdult: false, countryOfOrigin: "JP", genre_in: $g${k}, tag_in: $t${k},
        source: $s${k}, minimumTagRank: $r${k}, sort: POPULARITY_DESC) { id startDate { year } relations { edges { relationType node { type } } } } }`;
    });
    const d = await gql<
      Record<
        string,
        {
          media: {
            id: number;
            startDate: { year: number | null } | null;
            relations: { edges: { relationType: string; node: { type: string } }[] } | null;
          }[];
        }
      >
    >(`query (${decl.join(", ")}) { ${body.join(" ")} }`, vars);
    for (let k = 0; k < chunk.length; k++)
      out.push(
        (d[`p${k}`]?.media ?? []).map((m) => ({
          id: m.id,
          year: m.startDate?.year ?? null,
          firstSeason: !(m.relations?.edges ?? []).some(
            (e) => (e.relationType === "PREQUEL" || e.relationType === "PARENT") && e.node.type === "ANIME",
          ),
        })),
      );
  }
  return out;
}

export interface AniListEntry {
  mediaId: number;
  status: string;
  score: number;
  progress: number;
}

/** A user's public AniList anime list. */
export async function anilistUserList(userName: string): Promise<AniListEntry[]> {
  const d = await gql<{ MediaListCollection: { lists: { entries: AniListEntry[] }[] } }>(
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
      const d = await gql<{
        Page: { pageInfo: { hasNextPage: boolean }; airingSchedules: { mediaId: number; episode: number; airingAt: number }[] };
      }>(
        `query ($ids: [Int], $from: Int, $to: Int, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { mediaId episode airingAt } } }`,
        { ids: ids.slice(i, i + 50), from, to, page },
      );
      out.push(...d.Page.airingSchedules);
      if (!d.Page.pageInfo.hasNextPage) break;
    }
  }
  return out;
}
