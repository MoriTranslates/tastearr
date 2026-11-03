import { selectAutoAdd, type AutoAddPick } from "../core/autoadd.js";
import { seasonOf, shiftSeason, type Season } from "../core/taste/media.js";
import type { Ctx } from "../core/taste/types.js";
import { autoAddedIds, autoAddedInSeason, recordAutoAdd } from "../data/autoadd.js";
import { noteJobError } from "../data/jobs.js";
import { context, invalidateContext } from "./context.js";
import { firstOfMany, mappingTables } from "./mapping.js";
import { send } from "./notify.js";
import { recommend, setFeedback } from "./picks.js";
import { getProfile } from "./profile.js";
import { addMovie } from "./radarr.js";
import { getSettings, radarrConfigured, sonarrConfigured } from "./settings.js";
import { addSeries, monitorSeason } from "./sonarr.js";

/** Runs auto-add (see core/autoadd.ts) against Sonarr/Radarr, and remembers what it did. */

export { autoAddHistory } from "../data/autoadd.js";

/**
 * What auto-add would do for a season, best first, already capped. Read-only. `ctx`: the context auto-add checked
 * (fresh, nothing degraded); without it the cached one is used (the preview).
 */
export async function autoAddCandidates(season: Season, year: number, ctx?: Ctx): Promise<AutoAddPick[]> {
  const s = getSettings();
  const sonarrOn = sonarrConfigured();
  const done = autoAddedIds();
  const { picks } = await recommend(season, year, false, ctx);
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
  return (await runAutoAddDetailed()).added;
}

/**
 * runAutoAdd, also reporting the shows whose add failed ("title: reason") and how many were tried, so the background
 * refresh can show a partial failure instead of "done".
 */
export async function runAutoAddDetailed() {
  const s = getSettings();
  const added: { title: string; detail: string }[] = [];
  const failed: string[] = [];
  let tried = 0;
  if (!s.autoAdd.enabled || running) return { added, failed, tried };
  running = true;
  try {
    // A fresh library: deciding "add" vs "monitor" from a stale or partial one could add a show the user already owns.
    const ctx = await context(true);
    if (ctx.degraded?.length) throw new Error(`Auto-add skipped because a source couldn't be read: ${ctx.degraded.join("; ")}`);
    // A provisional profile (built while a source was down) never decides what gets added.
    const profile = await getProfile();
    if (profile.partial?.length)
      throw new Error(
        `Auto-add skipped: the taste profile is partial (built without ${profile.partial.join(", ")}); it runs after a complete build`,
      );
    const cur = seasonOf();
    for (const { season, year } of [cur, shiftSeason(cur, 1)]) {
      // The candidates come from the context checked above, never from one built in between (review #11).
      for (const p of await autoAddCandidates(season, year, ctx)) {
        tried++;
        try {
          const detail = await apply(p, s.autoAdd.search);
          // Already there and nothing to turn on: not something auto-add did, so it isn't recorded ("at most once").
          if (detail === null) continue;
          recordAutoAdd({ id: p.id, title: p.title, season, year, match: p.match, detail });
          setFeedback(p.id, "added", "auto");
          added.push({ title: `${p.title} (${p.match}%)`, detail });
        } catch (e) {
          console.warn(`Auto-add of ${p.title} failed, will retry: ${(e as Error).message}`);
          failed.push(`${p.title}: ${(e as Error).message}`);
        }
      }
    }
    if (failed.length) noteJobError("refresh", `Auto-add failed for ${failed.length} show(s), will retry: ${failed.join("; ")}`);
    if (added.length) {
      invalidateContext();
      const ext = s.externalUrl;
      await send({
        title: `Tastearr added ${added.length} show${added.length > 1 ? "s" : ""}`,
        body: added.map((a) => `${a.title} → ${a.detail}`).join("\n"),
        url: ext ? `${ext}/settings` : undefined,
        // The summary is a courtesy: the adds are already recorded and listed under auto-add history, and send()
        // logs which channels failed.
      }).catch(() => undefined);
    }
    return { added, failed, tried };
  } finally {
    running = false;
  }
}

/** Sends one pick to Radarr or Sonarr; returns where it went, for the history, or null when nothing changed. */
async function apply(p: AutoAddPick, search: boolean): Promise<string | null> {
  if (p.section === "movies") {
    const t = await mappingTables();
    const r = await addMovie({ tmdbId: p.tmdbId, imdbId: t.imdbByAnilist.get(p.id) ?? null }, { search });
    return r.alreadyAdded ? null : "Radarr";
  }
  if (p.autoAction === "monitor") {
    const r = await monitorSeason(p.tvdbId!, p.tvdbSeason!, search);
    return `Sonarr, season ${r.season}${r.waitingForSeason ? " (when TVDB lists it)" : ""}`;
  }
  const map = { tvdbId: p.tvdbId!, season: p.tvdbSeason };
  const r = await addSeries(p.tvdbId!, p.tvdbSeason, { search, firstOfMany: await firstOfMany(map) });
  if (r.alreadyAdded && !r.seasonMonitored) return null;
  return `Sonarr, ${r.monitored.toLowerCase()}`;
}
