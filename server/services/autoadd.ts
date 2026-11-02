import { selectAutoAdd, type AutoAddPick } from "../core/autoadd.js";
import { seasonOf, shiftSeason, type Season } from "../core/taste/media.js";
import { autoAddedIds, autoAddedInSeason, recordAutoAdd } from "../data/autoadd.js";
import { invalidateContext } from "./context.js";
import { firstOfMany, mappingTables } from "./mapping.js";
import { send } from "./notify.js";
import { recommend, setFeedback } from "./picks.js";
import { addMovie } from "./radarr.js";
import { getSettings, radarrConfigured, sonarrConfigured } from "./settings.js";
import { addSeries, monitorSeason } from "./sonarr.js";

/** Runs auto-add (see core/autoadd.ts) against Sonarr/Radarr, and remembers what it did. */

export { autoAddHistory } from "../data/autoadd.js";

/** What auto-add would do for a season, best first, already capped. Read-only. */
export async function autoAddCandidates(season: Season, year: number): Promise<AutoAddPick[]> {
  const s = getSettings();
  const sonarrOn = sonarrConfigured();
  const done = autoAddedIds();
  const { picks } = await recommend(season, year);
  return selectAutoAdd(picks, {
    cfg: s.autoAdd,
    done,
    sonarrOn,
    radarrOn: radarrConfigured(),
    room: s.autoAdd.maxPerSeason - autoAddedInSeason(season, year),
  });
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
          const detail = await apply(p, s.autoAdd.search);
          recordAutoAdd({ id: p.id, title: p.title, season, year, match: p.match, detail });
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

/** Sends one pick to Radarr or Sonarr; returns where it went, for the history. */
async function apply(p: AutoAddPick, search: boolean) {
  if (p.section === "movies") {
    const t = await mappingTables();
    await addMovie({ tmdbId: p.tmdbId, imdbId: t.imdbByAnilist.get(p.id) ?? null });
    return "Radarr";
  }
  if (p.autoAction === "monitor") {
    const r = await monitorSeason(p.tvdbId!, p.tvdbSeason!, search);
    return `Sonarr, season ${r.season}${r.waitingForSeason ? " (when TVDB lists it)" : ""}`;
  }
  const map = { tvdbId: p.tvdbId!, season: p.tvdbSeason };
  const r = await addSeries(p.tvdbId!, p.tvdbSeason, { search, firstOfMany: await firstOfMany(map) });
  return `Sonarr, ${r.monitored.toLowerCase()}`;
}
