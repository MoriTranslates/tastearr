import type { Season } from "../../../shared/api.js";

export type { Season };

/** AniList anime entries as the taste engine sees them (the fields the AniList adapter requests). */
export interface Relation {
  relationType: string;
  node: { id: number; type: string; format: string | null };
}

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

/** Cached media by AniList id, or null when it hasn't been fetched. Never touches the network. */
export type MediaLookup = (id: number) => Media | null;

export const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];

export function seasonOf(date = new Date()): { season: Season; year: number } {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}

export function shiftSeason(s: { season: Season; year: number }, by: number) {
  const idx = s.year * 4 + SEASONS.indexOf(s.season) + by;
  return { season: SEASONS[((idx % 4) + 4) % 4], year: Math.floor(idx / 4) };
}

/** Seasons as consecutive integers, for "how many seasons ago". */
export const seasonIdx = (s: { season: Season; year: number }) => s.year * 4 + SEASONS.indexOf(s.season);

/** AniList genres with a plain-English hint for people new to anime terms. */
export function allGenres(): { key: string; label: string }[] {
  return [
    ["Action", ""],
    ["Adventure", ""],
    ["Comedy", ""],
    ["Drama", ""],
    ["Ecchi", "fan service, sexy"],
    ["Fantasy", ""],
    ["Horror", ""],
    ["Mahou Shoujo", "magical girls"],
    ["Mecha", "giant robots"],
    ["Music", ""],
    ["Mystery", ""],
    ["Psychological", ""],
    ["Romance", ""],
    ["Sci-Fi", ""],
    ["Slice of Life", "everyday life"],
    ["Sports", ""],
    ["Supernatural", ""],
    ["Thriller", ""],
  ].map(([key, hint]) => ({ key, label: hint ? `${key} (${hint})` : key }));
}
