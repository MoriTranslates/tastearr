import fs from "node:fs";
import { db } from "../server/data/db.js";
import path from "node:path";
import type { Media } from "../server/core/taste/media.js";
import { seasonOf, shiftSeason } from "../server/core/taste/media.js";
import { json, mockFetch, media, tags } from "./helpers.ts";

/**
 * A fake outside world for service tests: AniList, MyAnimeList, Sonarr, Radarr and ntfy answered from plain state that
 * a test edits (and can break), so services run end to end with no real network. Hosts end in ".test".
 */

export const SONARR = "http://sonarr.test:8989";
export const RADARR = "http://radarr.test:7878";
export const NTFY = "http://ntfy.test/alerts";

export interface World {
  /** AniList seasons by "SEASON-YEAR"; unknown seasons are empty. */
  seasons: Map<string, Media[]>;
  /** Everything AniList knows by id (seasons are added automatically). */
  byId: Map<number, Media>;
  anilistList: { mediaId: number; status: string; score: number; progress: number }[];
  malList: { id: number; status: string; score: number; eps: number }[];
  aired: { mediaId: number; episode: number; airingAt: number }[];
  sonarrSeries: Record<string, unknown>[];
  /** Series Sonarr "knows" for lookup, by tvdb id. */
  sonarrLookup: Map<number, Record<string, unknown>>;
  sonarrAdded: Record<string, unknown>[];
  ntfySent: { title: string; message: string }[];
  /** Per-service switches: respond with this HTTP status instead of working. */
  fail: Partial<Record<"anilistSeason" | "anilistList" | "anilistAired" | "mal" | "sonarr" | "sonarrAdd" | "ntfy", number>>;
  /** Requests failing for specific tvdb ids on add. */
  failAddFor: Set<number>;
}

export function newWorld(): World {
  return {
    seasons: new Map(),
    byId: new Map(),
    anilistList: [],
    malList: [],
    aired: [],
    sonarrSeries: [],
    sonarrLookup: new Map(),
    sonarrAdded: [],
    ntfySent: [],
    fail: {},
    failAddFor: new Set(),
  };
}

const gql = (data: unknown) => json({ data }, 200);
const rl = { "x-ratelimit-limit": "90", "x-ratelimit-remaining": "80" };

export function addToSeason(w: World, season: string, year: number, list: Media[]) {
  const key = `${season}-${year}`;
  w.seasons.set(key, [...(w.seasons.get(key) ?? []), ...list]);
  for (const m of list) w.byId.set(m.id, m);
}

/** Installs the fake fetch. Also makes AniList's rate-limit and retry waits instant. */
export function installWorld(w: World) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...a: unknown[]) =>
    realSetTimeout(fn, (ms ?? 0) >= 300 ? 0 : ms, ...a)) as typeof setTimeout;
  const m = mockFetch((u, call) => {
    const body = call.body as { query?: string; variables?: Record<string, unknown> };
    if (u.hostname === "graphql.anilist.co") {
      const q = body.query ?? "";
      const v = body.variables ?? {};
      const withRl = (r: Response) => {
        for (const [k, val] of Object.entries(rl)) r.headers.set(k, val);
        return r;
      };
      const page = (list: Media[]) => gql({ Page: { pageInfo: { hasNextPage: false }, media: list } });
      if (q.includes("airingSchedules")) {
        if (w.fail.anilistAired) return json({}, w.fail.anilistAired);
        const ids = (v.ids as number[]) ?? [];
        return withRl(gql({ Page: { pageInfo: { hasNextPage: false }, airingSchedules: w.aired.filter((a) => ids.includes(a.mediaId)) } }));
      }
      if (q.includes("MediaListCollection")) {
        if (w.fail.anilistList) return withRl(json({}, w.fail.anilistList));
        return withRl(gql({ MediaListCollection: { lists: [{ entries: w.anilistList }] } }));
      }
      if (v.season !== undefined) {
        if (w.fail.anilistSeason) return withRl(json({}, w.fail.anilistSeason));
        return withRl(page(w.seasons.get(`${v.season}-${v.year}`) ?? []));
      }
      if (q.includes("id_in")) return withRl(page(((v.ids as number[]) ?? []).map((id) => w.byId.get(id)).filter((x): x is Media => !!x)));
      return withRl(page([]));
    }
    if (u.hostname === "api.myanimelist.net") {
      if (w.fail.mal) return json({}, w.fail.mal);
      return json({
        data: w.malList.map((e) => ({ node: { id: e.id }, list_status: { status: e.status, score: e.score, num_episodes_watched: e.eps } })),
        paging: {},
      });
    }
    if (u.hostname === "sonarr.test") {
      if (w.fail.sonarr) return json({}, w.fail.sonarr);
      const p = u.pathname.replace("/api/v3", "");
      if (p === "/series" && call.method === "GET") return json(w.sonarrSeries);
      if (p === "/series/lookup") {
        const id = Number(u.searchParams.get("term")?.replace("tvdb:", ""));
        const s = w.sonarrLookup.get(id);
        return json(s ? [s] : []);
      }
      if (p === "/series" && call.method === "POST") {
        const s = call.body as { tvdbId: number; title: string };
        if (w.fail.sonarrAdd || w.failAddFor.has(s.tvdbId)) return json({ message: "boom" }, w.fail.sonarrAdd ?? 500);
        w.sonarrAdded.push(s);
        return json({ id: 1000 + w.sonarrAdded.length, title: s.title });
      }
      if (p === "/tag") return call.method === "POST" ? json({ id: 1 }) : json([]);
      if (p === "/qualityprofile") return json([{ id: 4, name: "HD" }]);
    }
    if (u.hostname === "radarr.test") return json([]);
    if (u.hostname === "ntfy.test") {
      if (w.fail.ntfy) return json({}, w.fail.ntfy);
      const b = call.body as { title: string; message: string };
      w.ntfySent.push({ title: b.title, message: b.message });
      return json({ id: "x" });
    }
  });
  return {
    calls: m.calls,
    restore() {
      m.restore();
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

/** Writes the community anime list where the mapping service looks for it (fresh, so it is never downloaded). */
export function writeAnimeList(rows: unknown[]) {
  fs.writeFileSync(path.join(process.env.TASTEARR_CONFIG!, "anime-list-full.json"), JSON.stringify(rows));
}

/** A TV show with genres and enough tags to be a real candidate. */
export function show(id: number, over: Partial<Media> = {}): Media {
  return media(id, { genres: ["Fantasy"], tags: tags("Isekai", "Magic", "Swordplay"), popularity: 1000 + id, ...over });
}

export const quietWarn = async <T>(fn: () => Promise<T>) => {
  const warn = console.warn;
  const msgs: string[] = [];
  console.warn = (...a: unknown[]) => void msgs.push(a.join(" "));
  try {
    return { value: await fn(), warnings: msgs };
  } finally {
    console.warn = warn;
  }
};

const FANTASY_TAGS = tags("Isekai", "Magic", "Swordplay", "Adventure", "Female Protagonist", "Elf");
const ROMANCE_TAGS = tags("School", "Love Triangle", "Romance", "Heterosexual", "Shounen", "Slice of Life");

/** Loved fantasy history last season plus `n` fresh fantasy candidates this season (ids 300+). Returns the candidates. */
export function seedTaste(w: World, n = 3) {
  const cur = seasonOf();
  const prev = shiftSeason(cur, -1);
  const loved = Array.from({ length: 14 }, (_, i) => show(100 + i, { season: prev.season, seasonYear: prev.year, tags: FANTASY_TAGS }));
  const other = Array.from({ length: 14 }, (_, i) =>
    show(200 + i, { season: prev.season, seasonYear: prev.year, genres: ["Romance"], tags: ROMANCE_TAGS }),
  );
  addToSeason(w, prev.season, prev.year, [...loved, ...other]);
  w.anilistList = loved.map((m) => ({ mediaId: m.id, status: "COMPLETED", score: 90, progress: 12 }));
  const fresh = Array.from({ length: n }, (_, i) =>
    show(300 + i, {
      title: { romaji: `Tabi ${i}`, english: `Journey ${i}`, native: `旅 ${i}` },
      season: cur.season,
      seasonYear: cur.year,
      tags: FANTASY_TAGS,
    }),
  );
  addToSeason(w, cur.season, cur.year, fresh);
  return fresh;
}

/** Empties the user-data tables (and the AniList cache; not settings) so each test starts from a clean slate. */
export function resetUserData() {
  db.exec(
    "DELETE FROM auto_added; DELETE FROM feedback; DELETE FROM following; DELETE FROM aired_notified; DELETE FROM list_entries; DELETE FROM jobs; DELETE FROM notified; DELETE FROM dropped; DELETE FROM media; DELETE FROM season_fetch;",
  );
}
