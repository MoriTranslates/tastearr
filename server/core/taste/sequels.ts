import { EPISODIC_FORMATS } from "./features.js";
import type { Media, MediaLookup } from "./media.js";
import type { Ctx, Mapping } from "./types.js";

/** Franchise relations between AniList entries: prequels, parents, source material, and TVDB guesses for new seasons. */

const isAnime = (e: { node: { type: string } }) => e.node.type === "ANIME";
export const prequelIds = (m: Media) =>
  (m.relations?.edges ?? []).filter((e) => e.relationType === "PREQUEL" && isAnime(e)).map((e) => e.node.id);
// The manga/novel a show is based on (AniList links it as ADAPTATION or SOURCE; a related manga as ALTERNATIVE, last).
const SOURCE_REL = ["SOURCE", "ADAPTATION", "ALTERNATIVE"];
export const sourceIds = (m: Media) =>
  (m.relations?.edges ?? [])
    .filter((e) => SOURCE_REL.includes(e.relationType) && e.node.type === "MANGA")
    .sort((a, b) => SOURCE_REL.indexOf(a.relationType) - SOURCE_REL.indexOf(b.relationType))
    .map((e) => e.node.id);
export const parentIds = (m: Media) =>
  (m.relations?.edges ?? []).filter((e) => e.relationType === "PARENT" && isAnime(e)).map((e) => e.node.id);

/**
 * The seasons directly before `x`, nearest first. TV/ONA prequels come first: a series' AniList "prequel" list often
 * includes a movie or recap special next to the real season. A recap special or OVA between two seasons isn't a
 * season, so it is looked through (up to two hops) to what came before.
 */
export function previousSeasons(x: Media, lookup: MediaLookup): Media[] {
  const episodicFirst = (ids: number[]) =>
    ids
      .map(lookup)
      .filter((y): y is Media => !!y && y.format !== "MUSIC")
      .sort((a, b) => Number(EPISODIC_FORMATS.has(b.format ?? "")) - Number(EPISODIC_FORMATS.has(a.format ?? "")));
  const out: Media[] = [];
  const seen = new Set<number>();
  const visit = (ids: number[], hops: number) => {
    for (const y of episodicFirst(ids)) {
      if (seen.has(y.id)) continue;
      seen.add(y.id);
      const before = !EPISODIC_FORMATS.has(y.format ?? "") && y.format !== "MOVIE" && hops < 2 ? prequelIds(y) : [];
      if (before.length) visit(before, hops + 1);
      else out.push(y);
    }
  };
  visit(prequelIds(x), 0);
  return episodicFirst(out.map((y) => y.id));
}

/** Split cours ("Part 2", "2nd cour") are filed by TVDB under the same season as their first half. */
export const isSplitCour = (m: { title: { english: string | null; romaji: string | null } }) =>
  /part\s*(2|ii)|2nd cour|cour 2/i.test(`${m.title.english} ${m.title.romaji}`);

/**
 * A new season the community list hasn't mapped yet, whose previous season is in Sonarr: same TVDB series, next season
 * number when Sonarr already lists it and nothing else claims it. Otherwise the season stays unknown (new episodes
 * only), which is also right for split-cour "Part 2"s that TVDB files under the same season.
 */
export function inferMapping(m: Media, immediate: Media | null, ctx: Ctx): Mapping | undefined {
  if (!EPISODIC_FORMATS.has(m.format ?? "")) return undefined;
  // Already added to Sonarr under exactly this title (by hand, or by Sonarr's own search): that's the match.
  const norm = (t: string | null | undefined) => (t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const names = new Set([norm(m.title.english), norm(m.title.romaji)].filter(Boolean));
  const year = m.startDate?.year ?? m.seasonYear ?? null;
  for (const series of ctx.lib.values()) {
    if (!names.has(norm(series.title)) || ctx.byTvdb.has(series.tvdbId) || series.seriesType !== "anime") continue;
    const sy = (series.year as number | undefined) ?? null;
    if (year && sy && Math.abs(year - sy) > 1) continue;
    const real = series.seasons.filter((x) => x.seasonNumber > 0).length;
    return { tvdbId: series.tvdbId, season: real === 1 ? 1 : null };
  }
  if (!immediate || !EPISODIC_FORMATS.has(immediate.format ?? "")) return undefined;
  const pm = ctx.byAnilist.get(immediate.id);
  const series = pm ? ctx.lib.get(pm.tvdbId) : undefined;
  if (!pm || !series) return undefined;
  const next = pm.season ? pm.season + 1 : null;
  const claimed = (ctx.byTvdb.get(pm.tvdbId) ?? []).some((id) => ctx.byAnilist.get(id)?.season === next);
  const season = next && !claimed && series.seasons.some((x) => x.seasonNumber === next) && !isSplitCour(m) ? next : null;
  return { tvdbId: pm.tvdbId, season };
}
