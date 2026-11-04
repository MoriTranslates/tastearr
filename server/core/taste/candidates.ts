import { CANDIDATE_FORMATS, isExplicitShort } from "./features.js";
import { SEASONS, type Media, type Season } from "./media.js";
import { parentIds, prequelIds, sourceIds } from "./sequels.js";
import type { Ctx, TasteConfig } from "./types.js";

/** Which shows are scored for a season: its line-up, plus carry-overs the user follows that air into it. */

/** First day of a season, local time. */
export const seasonStart = (season: Season, year: number) => new Date(year, SEASONS.indexOf(season) * 3, 1).getTime();

/**
 * A show worth scoring at all: not adult, a TV/ONA/short/movie format, from a country the user trains on, and (unless
 * the user turned it off) not an explicit short: it shows actual sex, which the user doesn't want (see isExplicitShort).
 */
export function isCandidate(m: Media, cfg: TasteConfig) {
  const countries = new Set(cfg.training.countries);
  if (cfg.filters.skipExplicitShorts && isExplicitShort(m)) return false;
  return !m.isAdult && !!m.format && CANDIDATE_FORMATS.has(m.format) && (!m.countryOfOrigin || countries.has(m.countryOfOrigin));
}

/** When a show airs past the start of a season (for carry-overs). Unknown episode counts count as "yes". */
function airsInto(m: Media, start: number) {
  if (m.status !== "RELEASING" || !m.nextAiringEpisode) return false;
  if (!m.episodes) return true;
  const lastAir = m.nextAiringEpisode.airingAt * 1000 + (m.episodes - m.nextAiringEpisode.episode) * 7 * 86_400_000;
  return lastAir >= start;
}

/** Shows the user follows, is watching or plans to watch, whose earlier run may carry over into the season. */
export function carryOverIds(ctx: Ctx, season: Season, year: number): number[] {
  const followed = new Set<number>(ctx.following);
  for (const [id, e] of ctx.lists) if (e.status === "CURRENT" || e.status === "PLANNING") followed.add(id);
  // For a season that hasn't started, shows already in Sonarr are on My Shows; don't let them fill the top of next season.
  const upcoming = seasonStart(season, year) > Date.now();
  if (!upcoming)
    for (const [tvdb, x] of ctx.lib)
      if (x.seriesType === "anime" && x.status === "continuing" && x.monitored)
        for (const id of ctx.byTvdb.get(tvdb) ?? []) followed.add(id);
  return [...followed];
}

/** A fetched carry-over candidate that started before the season and is still airing into it. */
export function isCarryOver(m: Media, season: Season, year: number, cfg: TasteConfig) {
  return (
    isCandidate(m, cfg) &&
    airsInto(m, seasonStart(season, year)) &&
    m.seasonYear !== null &&
    (m.seasonYear ?? 0) * 4 + SEASONS.indexOf(m.season ?? "WINTER") < year * 4 + SEASONS.indexOf(season)
  );
}

/**
 * Entries to fetch before scoring: the prequel chain and parents, so sequels can inherit labels, titles and tags, and
 * the source manga of tag-sparse shows. Further prequels are found level by level with `prequelIds`.
 */
export function relatedIds(candidates: Media[], cfg: TasteConfig): number[] {
  const sparse = candidates.filter((m) => m.tags.filter((t) => t.rank >= cfg.training.minTagRank).length < 4);
  return [...new Set([...candidates.flatMap((m) => [...prequelIds(m), ...parentIds(m)]), ...sparse.flatMap(sourceIds)])];
}
