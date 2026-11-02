// No imports on purpose: the server-side test project type-checks this file without the browser libraries.
type Season = "WINTER" | "SPRING" | "SUMMER" | "FALL";
type SeasonYear = { season: Season; year: number };

const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];

/** The season the calendar is in now (same quarters as the server's seasonOf). */
export const currentSeason = (now = new Date()): SeasonYear => ({
  season: SEASONS[Math.floor(now.getMonth() / 3)],
  year: now.getFullYear(),
});

/** What the Picks URL asks for: a season (else the one the server says is current, else today's), and the view and day. */
export function readPicksQuery(search: string, status: { season?: SeasonYear }, storedView: string, now = new Date()) {
  const q = new URLSearchParams(search);
  const season = SEASONS.find((x) => x === q.get("season")?.toUpperCase());
  const year = Number(q.get("year"));
  const dayParam = q.get("day");
  return {
    sel: season && year ? { season, year } : (status.season ?? currentSeason(now)),
    view: (q.get("view") ?? storedView) === "schedule" ? ("schedule" as const) : ("grid" as const),
    day: dayParam !== null && dayParam !== "" ? Number(dayParam) : null,
  };
}
