import type { MonitorChoice } from "../../shared/api.js";
import type { LibrarySeries } from "./taste/types.js";

/**
 * How a pick goes into Sonarr: which seasons to monitor and whether to search. The default never downloads a back
 * catalogue the user didn't ask for: sequels get only their season, unclear cases only new episodes.
 */

export type { MonitorChoice };

/** Default monitoring for a pick: a sequel the user doesn't own gets only its season; anything unclear gets "future". */
export function defaultMonitor(season: number | null, sequelMonitor: "newSeason" | "all", firstOfMany = false): MonitorChoice {
  if (season === 1) return firstOfMany ? "future" : "all";
  if (season && season > 1) return sequelMonitor === "newSeason" ? "season" : "all";
  return "future"; // season unknown or specials: never grab a whole back catalogue by surprise
}

export const MONITOR_LABEL: Record<MonitorChoice, (s: number | null) => string> = {
  season: (s) => `Season ${s} only`,
  all: () => "All seasons",
  future: () => "Only new episodes from now on",
  none: () => "Nothing (add it unmonitored)",
};

/** The choices offered in the Add dialog. */
export function monitorOptions(season: number | null) {
  const options: { value: MonitorChoice; label: string }[] = [];
  if (season && season > 1) options.push({ value: "season", label: MONITOR_LABEL.season(season) });
  options.push(
    { value: "all", label: MONITOR_LABEL.all(null) },
    { value: "future", label: MONITOR_LABEL.future(null) },
    { value: "none", label: MONITOR_LABEL.none(null) },
  );
  return options;
}

/**
 * Sets the season monitoring on Sonarr's lookup result `s` (in place) and works out the add options. "season" falls
 * back to "future" without a real season number; a season TVDB doesn't list yet is picked up when it appears.
 */
export function planSeriesAdd(s: LibrarySeries, season: number | null, choice: MonitorChoice, searchWanted: boolean) {
  let monitor = choice;
  if (monitor === "season" && !(season && season > 1)) monitor = "future";
  const listed = monitor === "season" && s.seasons.some((x) => x.seasonNumber === season);
  for (const x of s.seasons)
    x.monitored = monitor === "all" ? x.seasonNumber > 0 : monitor === "season" ? listed && x.seasonNumber === season : false;
  const search = searchWanted && (monitor === "all" || listed);
  const addOptions =
    monitor === "season"
      ? listed
        ? { searchForMissingEpisodes: search }
        : { monitor: "future", searchForMissingEpisodes: false }
      : monitor === "all"
        ? { monitor: "all", searchForMissingEpisodes: search }
        : { monitor: monitor === "future" ? "future" : "none", searchForMissingEpisodes: false };
  return { monitor, listed, addOptions };
}

export interface TitleMatch {
  tvdbId: number;
  title: string;
  year: number | null;
  network: string | null;
  seasons: number[];
  overview: string | null;
  inLibrary: boolean;
  confident: boolean;
  rank: number;
}

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

/** How well a Sonarr search result `x` matches the show's titles and start year. */
export function rateTitleMatch(x: LibrarySeries, titles: string[], year: number | null, owned: Set<number>): TitleMatch {
  const want = words(titles.join(" "));
  const y = x.year || null;
  const have = words(x.title);
  // Shared words over the longer of the two titles, so "Dark Blue" doesn't look like a match for a long title.
  const shared = [...have].filter((w) => want.has(w)).length;
  const overlap = shared / Math.max(1, have.size, Math.min(want.size, 8));
  // Best guess first: title overlap, a little extra when it's a series already in Sonarr (a new season of something
  // owned) and still a close title, then a plausible year (a series can't start after the show we're matching).
  const rank =
    overlap * 2 + (owned.has(x.tvdbId) && overlap >= 0.5 ? 0.5 : 0) + (year && y ? (Math.abs(year - y) <= 1 ? 0.5 : y > year ? -1 : 0) : 0);
  return {
    tvdbId: x.tvdbId,
    title: x.title,
    year: y,
    network: x.network ?? null,
    seasons: x.seasons.map((z) => z.seasonNumber).filter((n) => n > 0),
    overview: (x.overview ?? "").slice(0, 200) || null,
    inLibrary: owned.has(x.tvdbId),
    // Half the words in common or more: worth offering as "Is this it?". Below that, just list them.
    confident: overlap >= 0.5 && (shared >= 2 || have.size === 1),
    rank,
  };
}
