import { inBackground } from "../adapters/anilist.js";
import { seasonOf, shiftSeason } from "../core/taste/media.js";
import { setJob } from "../data/jobs.js";
import { runAutoAddDetailed } from "./autoadd.js";
import { context } from "./context.js";
import { announceAired } from "./following.js";
import { notifySeason } from "./notify.js";
import { recommend } from "./picks.js";
import { getProfile } from "./profile.js";
import { prewarmQuiz } from "./quiz.js";
import { getSettings } from "./settings.js";
import { flushPending, resumePendingAlerts } from "./webhooks.js";

/** Background work: the 6-hourly refresh (profile, picks, season alert, auto-add) and half-hourly airing alerts. */

type Log = (msg: string) => void;

/**
 * One refresh. Each step runs even when an earlier one failed (an AniList outage during the profile build must not
 * also skip auto-add from the last good profile); the job ends in "error" naming every step that failed.
 */
export function refresh(warn: Log) {
  // Background lane: a page the user opens meanwhile gets its AniList calls first.
  return inBackground(() => refreshSteps(warn));
}

async function refreshSteps(warn: Log) {
  setJob("refresh", "running", "Refreshing seasons");
  const failed: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`);
    }
  };
  const cur = seasonOf();
  const next = shiftSeason(cur, 1);
  if (getSettings().auth.passwordHash) {
    // Strict: a rebuild that failed (or kept the old profile because Sonarr/Plex didn't answer) fails this step too.
    await step("taste profile", () => getProfile(undefined, { strict: true }));
    // Picks and the season alert from an incomplete library would treat owned shows as new: skip both, named in the
    // job's error. (notifySeason refuses on its own too; auto-add checks a fresh context itself.)
    let degraded: string[] = [];
    await step("sources", async () => void (degraded = (await context()).degraded ?? []));
    if (degraded.length) failed.push(`picks and season alert: skipped because a source couldn't be read: ${degraded.join("; ")}`);
    else {
      await step("picks", () => recommend(cur.season, cur.year));
      await step("season alert", () => notifySeason(next.season, next.year));
    }
    await step("auto-add", async () => {
      // Shows that failed are retried next run, but the run is a partial failure, not "up to date".
      const r = await runAutoAddDetailed();
      if (r.failed.length) throw new Error(`${r.failed.length} of ${r.tried} shows failed (retried next run): ${r.failed.join("; ")}`);
    });
  }
  if (failed.length) {
    setJob("refresh", "error", failed.join("; "));
    warn(`Background refresh failed: ${failed.join("; ")}`);
  } else setJob("refresh", "done", "Seasons up to date");
}

/** Starts the timers. Returns a stop function that also sends any batched episode alerts (for shutdown). */
export function startJobs(warn: Log) {
  const resumed = resumePendingAlerts();
  if (resumed) warn(`Sending ${resumed} episode alert batch${resumed > 1 ? "es" : ""} left from before the restart`);
  const timers = [
    setTimeout(() => void refresh(warn), 15_000),
    setInterval(() => void refresh(warn), 6 * 3_600_000),
    setInterval(() => void inBackground(announceAired).catch((e) => warn(`Airing alerts failed: ${(e as Error).message}`)), 30 * 60_000),
  ];
  // A new install with nothing connected will start with the quiz: have it ready.
  const s = getSettings();
  if (!s.sonarr.url && !s.lists.anilistUser && Object.keys(s.genrePrefs).length === 0)
    timers.push(setTimeout(() => void inBackground(async () => prewarmQuiz()), 3_000));
  return {
    stop() {
      for (const t of timers) clearTimeout(t);
    },
    flush: flushPending,
  };
}
