import type { FastifyRequest } from "fastify";
import type { Media } from "../server/core/taste/media.js";
import type { Ctx } from "../server/core/taste/types.js";

export interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}
export type Route = (url: URL, call: Call) => Response | undefined | Promise<Response | undefined>;

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replaces global fetch with `route`; unrouted URLs fail. Returns the recorded calls. */
export function mockFetch(route: Route) {
  const calls: Call[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* plain text */
      }
    }
    const call = { url, method: init.method ?? "GET", body, headers };
    calls.push(call);
    const res = await route(new URL(url), call);
    if (!res) throw new Error(`Unmocked fetch: ${call.method} ${url}`);
    return res;
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = prev) };
}

/** The bits of a Fastify request the auth helpers read. */
export function fakeReq(
  o: { ip?: string; peer?: string; headers?: Record<string, string>; method?: string; cookies?: Record<string, string> } = {},
) {
  const ip = o.ip ?? "192.168.1.20";
  return {
    ip,
    method: o.method ?? "GET",
    headers: { host: "192.168.1.5:8383", ...o.headers },
    socket: { remoteAddress: o.peer ?? ip },
    cookies: o.cookies ?? {},
  } as unknown as FastifyRequest;
}

export function media(id: number, over: Partial<Media> = {}): Media {
  return {
    id,
    title: { romaji: `Show ${id}`, english: `Show ${id}`, native: null },
    format: "TV",
    status: "NOT_YET_RELEASED",
    source: "MANGA",
    episodes: 12,
    duration: 24,
    season: "WINTER",
    seasonYear: 2030,
    startDate: { year: 2030, month: 1, day: 5 },
    countryOfOrigin: "JP",
    isAdult: false,
    popularity: 5000,
    averageScore: null,
    genres: [],
    tags: [],
    coverImage: { large: null, color: null },
    description: null,
    siteUrl: `https://anilist.co/anime/${id}`,
    studios: { nodes: [] },
    relations: { edges: [] },
    nextAiringEpisode: null,
    externalLinks: [],
    trailer: null,
    ...over,
  };
}

export const tags = (...names: string[]) => names.map((name) => ({ name, rank: 90, isGeneralSpoiler: false, isMediaSpoiler: false }));

export function emptyCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    lib: new Map(),
    movies: new Map(),
    watch: new Map(),
    fb: new Map(),
    dropped: new Set(),
    lists: new Map(),
    listScored: false,
    following: new Set(),
    byAnilist: new Map(),
    byTvdb: new Map(),
    movieByAnilist: new Map(),
    imdbByAnilist: new Map(),
    hasHistory: true,
    sources: {},
    ...over,
  };
}
