import { AsyncLocalStorage } from "node:async_hooks";
import type { Media, Season } from "../core/taste/media.js";

/**
 * AniList GraphQL API: season line-ups, entries by id, title search, quiz pools, users' lists and airing schedules.
 * Every call goes through one rate-limited scheduler with two lanes sharing the pace: interactive calls (a page the
 * user is waiting for) go before background work (profile builds, the 6-hourly refresh, airing alerts), and fail fast
 * on a long rate-limit wait instead of hanging past a proxy timeout. Caching is the caller's job (services/catalog.ts).
 */

/** Fields requested for every entry; bump MEDIA_SCHEMA in data/media.ts when this changes. */
const FIELDS = `id title { romaji english native } format status source episodes duration season seasonYear startDate { year month day }
  countryOfOrigin isAdult popularity averageScore genres tags { name rank isGeneralSpoiler isMediaSpoiler }
  coverImage { large color } description(asHtml: false) siteUrl studios(isMain: true) { nodes { name } }
  relations { edges { relationType node { id type format } } }
  nextAiringEpisode { airingAt episode } externalLinks { site url type } trailer { id site }`;

const ENDPOINT = "https://graphql.anilist.co";

/**
 * Pacing and retries. `gapMs` is the starting gap between calls (adjusted from X-RateLimit-Limit: 90/min normally,
 * 30/min when AniList is degraded). Network errors, timeouts and 5xx answers are retried with exponential backoff; a
 * 429 pauses every call for as long as Retry-After / X-RateLimit-Reset say. Background calls wait up to `maxWaitMs`
 * per pause; interactive calls wait at most `interactiveWaitMs` per pause and `interactiveTotalMs` in all, then fail
 * with the wait in the message. Tests shrink these.
 */
export const ANILIST_LIMITS = {
  gapMs: 800,
  retries: 4,
  backoffMs: 2_000,
  maxWaitMs: 120_000,
  interactiveWaitMs: 15_000,
  interactiveTotalMs: 45_000,
};
let learnedGap: number | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gap = () => learnedGap ?? ANILIST_LIMITS.gapMs;

/** Marks the async work started inside `fn` as background (lower priority, patient with rate limits). */
const lane = new AsyncLocalStorage<"background">();
export function inBackground<T>(fn: () => Promise<T>): Promise<T> {
  return lane.run("background", fn);
}
const isInteractive = () => lane.getStore() !== "background";

/**
 * The timer for awaitShared's deadline, taken when this module loads. Tests make long waits (rate limits, backoff)
 * instant by replacing setTimeout; a deadline that fired instantly would fail every interactive caller instead.
 */
const deadlineTimer = globalThis.setTimeout;

/**
 * Awaits shared work that may run in the background lane (a quiz pool or profile build started by a timer, joined by a
 * page). An interactive caller waits at most `interactiveTotalMs`, then gets an error saying `what` is still being
 * prepared; the work itself carries on. A background caller just waits.
 */
export function awaitShared<T>(p: Promise<T>, what: string): Promise<T> {
  if (!isInteractive()) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = deadlineTimer(
      () => reject(new Error(`${what} is still being prepared in the background; try again in a minute.`)),
      ANILIST_LIMITS.interactiveTotalMs,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const rateLimited = (ms: number) => new Error(`AniList's rate limit was hit; try again in ${Math.ceil(ms / 1000)} seconds.`);

// The scheduler: one start every `gap()`, shared by both lanes, interactive first. `nextAt` is the earliest the next
// request may start; a rate-limit pause moves it forward for everyone.
type Waiter = { go: () => void; fail: (e: Error) => void };
const waiting: { interactive: Waiter[]; background: Waiter[] } = { interactive: [], background: [] };
let nextAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function pump() {
  if (timer || (!waiting.interactive.length && !waiting.background.length)) return;
  const wait = nextAt - Date.now();
  if (wait > 0) {
    // When the timer fires the turn is taken without re-checking the clock (tests make long timers instant).
    timer = setTimeout(() => {
      timer = null;
      dispatch();
    }, wait);
    return;
  }
  dispatch();
}

function dispatch() {
  const w = waiting.interactive.shift() ?? waiting.background.shift();
  if (!w) return;
  nextAt = Date.now() + gap();
  w.go();
  pump();
}

/** Waits for this call's turn. An interactive caller facing a long pause fails at once instead of queueing. */
function turn(interactive: boolean): Promise<void> {
  const wait = nextAt - Date.now();
  if (wait > maxWait(interactive)) return Promise.reject(rateLimited(wait));
  return new Promise((go, fail) => {
    waiting[interactive ? "interactive" : "background"].push({ go, fail });
    pump();
  });
}

const maxWait = (interactive: boolean) => (interactive ? ANILIST_LIMITS.interactiveWaitMs : ANILIST_LIMITS.maxWaitMs);

/**
 * AniList asked everyone to wait `ms`. A wait longer than `maxWaitMs` is not waited out by anyone (the caller fails
 * with the wait in its message, and a later call probes again), so it doesn't pause the scheduler either. Queued
 * interactive callers that would wait longer than their lane allows fail now.
 */
function pauseFor(ms: number) {
  if (ms > ANILIST_LIMITS.maxWaitMs) return;
  const until = Date.now() + ms;
  if (until <= nextAt) return;
  nextAt = until;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (ms > ANILIST_LIMITS.interactiveWaitMs) for (const w of waiting.interactive.splice(0)) w.fail(rateLimited(ms));
  pump();
}

/** How long a 429 asks to wait: Retry-After (seconds or a date), else X-RateLimit-Reset (unix seconds), else null. */
export function rateLimitWaitMs(h: Headers, now = Date.now()): number | null {
  const ra = h.get("retry-after");
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = Number(h.get("x-ratelimit-reset"));
  return reset > 0 ? Math.max(0, reset * 1000 - now) : null;
}

/** Rate-limited AniList GraphQL call that honours the rate-limit headers and retries transient failures. */
async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { retries, backoffMs, maxWaitMs, interactiveTotalMs } = ANILIST_LIMITS;
  const interactive = isInteractive();
  const deadline = Date.now() + interactiveTotalMs;
  /** Whether waiting `ms` more is allowed: background calls always (each wait is capped), interactive ones within the deadline. */
  const mayWait = (ms: number) => !interactive || Date.now() + ms <= deadline;
  const backoff = (attempt: number) => Math.min(maxWaitMs, backoffMs * 2 ** attempt);
  for (let attempt = 0; ; attempt++) {
    await turn(interactive);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Tastearr (+https://github.com/MoriTranslates/tastearr)",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (attempt < retries && mayWait(backoff(attempt))) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new Error(`Can't reach AniList (${(e as Error).message}). Try again in a few minutes.`, { cause: e });
    }
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    if (limit > 0) learnedGap = Math.ceil(60_000 / limit) + 100;
    if (res.headers.get("x-ratelimit-remaining") === "0") pauseFor(rateLimitWaitMs(res.headers) ?? 60_000);
    if (res.status === 429) {
      const ms = rateLimitWaitMs(res.headers) ?? 60_000;
      pauseFor(ms);
      if (attempt < retries && ms <= maxWait(interactive) && mayWait(ms)) continue; // turn() waits out the pause
      throw rateLimited(ms);
    }
    if (res.status >= 500) {
      if (attempt < retries && mayWait(backoff(attempt))) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new Error(`AniList is having trouble right now (HTTP ${res.status}). Try again in a few minutes.`);
    }
    if (!res.ok)
      throw new Error(
        `AniList refused the request (HTTP ${res.status}): ${(await res.text())
          .replace(/<[^>]+>/g, " ")
          .trim()
          .slice(0, 160)}`,
      );
    let body: { data: T | null; errors?: { message: string }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new Error("AniList sent an answer that isn't valid JSON. Try again in a few minutes.", { cause: e });
    }
    if (body.errors?.length) throw new Error(`AniList: ${body.errors[0].message}`);
    if (!body.data) throw new Error("AniList sent an empty answer. Try again in a few minutes.");
    return body.data;
  }
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
  const d = await gql<{ MediaListCollection: { lists: { entries: AniListEntry[] | null }[] | null } | null }>(
    `query ($u: String) { MediaListCollection(userName: $u, type: ANIME) { lists { entries { mediaId status score(format: POINT_100) progress } } } }`,
    { u: userName },
  );
  // A missing collection must fail the import rather than look like an empty list (which would wipe the stored one).
  if (!d.MediaListCollection?.lists) throw new Error(`AniList user "${userName}" not found or their list is private`);
  return d.MediaListCollection.lists.flatMap((l) => l.entries ?? []).filter((e) => Number.isInteger(e?.mediaId));
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
