import { db } from "./db.js";
import { getMediaByIds, seasonOf, shiftSeason, type Season } from "./anilist.js";
import { mappingTables } from "./mapping.js";
import { send } from "./notify.js";
import { addMovie, radarrConfigured } from "./radarr.js";
import { getSettings } from "./settings.js";
import { addSeries, monitorSeason } from "./sonarr.js";
import { invalidateContext, recommend, setFeedback, type Pick } from "./taste.js";

/**
 * Auto-add: picks at or above a match % go to Sonarr/Radarr on their own, like an import list. Conservative on purpose:
 * only confident, mapped, non-short picks the user hasn't rated down, hidden, seen or followed; each show at most once
 * (removing it from Sonarr doesn't make it come back); a cap per season; and the same safe monitoring as the Add button.
 */

/** Long-runners that TVDB files as one big "season 1" (several AniList entries map there): never grab it all. */
export async function firstOfMany(map: { tvdbId: number; season: number | null }) {
  if (map.season !== 1) return false;
  const t = await mappingTables();
  const ids = (t.byTvdb.get(map.tvdbId) ?? []).filter((x) => t.byAnilist.get(x)?.season === 1);
  if (ids.length < 2) return false;
  const media = await getMediaByIds(ids);
  const years = media.map((x) => x.seasonYear ?? x.startDate?.year ?? 0).filter(Boolean);
  return media.some((x) => (x.episodes ?? 0) > 50) || (years.length > 1 && Math.max(...years) - Math.min(...years) >= 3);
}

const doneIds = () => new Set((db.prepare("SELECT anilist_id FROM auto_added").all() as { anilist_id: number }[]).map((r) => r.anilist_id));
const doneThisSeason = (season: Season, year: number) => (db.prepare("SELECT COUNT(*) AS n FROM auto_added WHERE season = ? AND year = ?").get(season, year) as { n: number }).n;

/** What auto-add would do for a season, best first, already capped. Read-only. */
export async function autoAddCandidates(season: Season, year: number): Promise<(Pick & { autoAction: "add" | "monitor" })[]> {
  const s = getSettings();
  const cfg = s.autoAdd;
  const sonarrOn = !!(s.sonarr.url && s.sonarr.apiKey);
  const done = doneIds();
  const { picks } = await recommend(season, year);
  const out: (Pick & { autoAction: "add" | "monitor" })[] = [];
  for (const p of picks) {
    if (p.match < cfg.minMatch || p.excluded || p.lowConfidence || done.has(p.id)) continue;
    // A 👍 is fine; any other verdict (added by hand, 👎, hidden) or own status (watching, seen, dropped, following) means hands off.
    if ((p.verdict && p.verdict !== "liked") || p.myStatus) continue;
    const wanted = p.section === "new" ? cfg.newShows : p.section === "continuing" ? cfg.sequels : p.section === "movies" ? cfg.movies : false;
    if (!wanted) continue;
    if (p.section === "movies") {
      if (p.addVia === "radarr" && !p.inLibrary && radarrConfigured()) out.push({ ...p, autoAction: "add" });
      continue;
    }
    if (!sonarrOn || !p.tvdbId) continue;
    if (!p.inLibrary && !p.needsMatch && !p.matchGuessed) out.push({ ...p, autoAction: "add" });
    else if (p.inLibrary && p.tvdbSeason && p.seasonMonitored === false) out.push({ ...p, autoAction: "monitor" });
  }
  return out.slice(0, Math.max(0, cfg.maxPerSeason - doneThisSeason(season, year)));
}

let running = false;

/** Runs auto-add for the current and next season. Returns what was added; failures are retried next run. */
export async function runAutoAdd() {
  const s = getSettings();
  if (!s.autoAdd.enabled || running) return [];
  running = true;
  const added: { title: string; detail: string }[] = [];
  try {
    const cur = seasonOf();
    for (const { season, year } of [cur, shiftSeason(cur, 1)]) {
      for (const p of await autoAddCandidates(season, year)) {
        try {
          let detail: string;
          if (p.section === "movies") {
            const t = await mappingTables();
            await addMovie({ tmdbId: p.tmdbId, imdbId: t.imdbByAnilist.get(p.id) ?? null });
            detail = "Radarr";
          } else if (p.autoAction === "monitor") {
            const r = await monitorSeason(p.tvdbId!, p.tvdbSeason!, s.autoAdd.search);
            detail = `Sonarr, season ${r.season}${r.waitingForSeason ? " (when TVDB lists it)" : ""}`;
          } else {
            const r = await addSeries(p.tvdbId!, p.tvdbSeason, { search: s.autoAdd.search, firstOfMany: await firstOfMany({ tvdbId: p.tvdbId!, season: p.tvdbSeason }) });
            detail = `Sonarr, ${r.monitored.toLowerCase()}`;
          }
          db.prepare("INSERT OR IGNORE INTO auto_added (anilist_id, title, season, year, match, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.id, p.title, season, year, p.match, detail, Date.now());
          setFeedback(p.id, "added", "auto");
          added.push({ title: `${p.title} (${p.match}%)`, detail });
        } catch (e) {
          console.warn(`Auto-add of ${p.title} failed, will retry: ${(e as Error).message}`);
        }
      }
    }
    if (added.length) {
      invalidateContext();
      const ext = s.externalUrl;
      await send({
        title: `Tastearr added ${added.length} show${added.length > 1 ? "s" : ""}`,
        body: added.map((a) => `${a.title} → ${a.detail}`).join("\n"),
        url: ext ? `${ext}/settings` : undefined,
      }).catch(() => undefined);
    }
    return added;
  } finally {
    running = false;
  }
}

export function autoAddHistory() {
  return db.prepare("SELECT anilist_id AS id, title, season, year, match, detail, at FROM auto_added ORDER BY at DESC LIMIT 50").all();
}
