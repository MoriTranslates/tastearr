import type { ScoredPick } from "../../shared/api.js";
import type { Settings } from "./settings.js";

/**
 * Auto-add: picks at or above a match % go to Sonarr/Radarr on their own, like an import list. Conservative on purpose:
 * only confident, mapped, non-short picks the user hasn't rated down, hidden, seen or followed; each show at most once
 * (removing it from Sonarr doesn't make it come back); a cap per season; and the same safe monitoring as the Add button.
 */

export type AutoAddPick = ScoredPick & { autoAction: "add" | "monitor" };

/** What auto-add would do with a season's picks, best first, capped at `room` shows. */
export function selectAutoAdd(
  picks: ScoredPick[],
  o: { cfg: Settings["autoAdd"]; done: Set<number>; sonarrOn: boolean; radarrOn: boolean; room: number },
): AutoAddPick[] {
  const { cfg, done } = o;
  const out: AutoAddPick[] = [];
  for (const p of picks) {
    if (p.match < cfg.minMatch || p.excluded || p.lowConfidence || done.has(p.id)) continue;
    // A 👍 is fine; any other verdict (added by hand, 👎, hidden) or own status (watching, seen, dropped, following) means hands off.
    if ((p.verdict && p.verdict !== "liked") || p.myStatus) continue;
    const wanted =
      p.section === "new" ? cfg.newShows : p.section === "continuing" ? cfg.sequels : p.section === "movies" ? cfg.movies : false;
    if (!wanted) continue;
    if (p.section === "movies") {
      if (p.addVia === "radarr" && !p.inLibrary && o.radarrOn) out.push({ ...p, autoAction: "add" });
      continue;
    }
    if (!o.sonarrOn || !p.tvdbId) continue;
    if (!p.inLibrary && !p.needsMatch && !p.matchGuessed) out.push({ ...p, autoAction: "add" });
    else if (p.inLibrary && p.tvdbSeason && p.seasonMonitored === false) out.push({ ...p, autoAction: "monitor" });
  }
  return out.slice(0, Math.max(0, o.room));
}
