import { seasonOf, shiftSeason } from "../core/taste/media.js";
import { setJob } from "../data/jobs.js";
import { runAutoAdd } from "./autoadd.js";
import { announceAired } from "./following.js";
import { notifySeason } from "./notify.js";
import { recommend } from "./picks.js";
import { getProfile } from "./profile.js";
import { prewarmQuiz } from "./quiz.js";
import { getSettings } from "./settings.js";
import { flushPending } from "./webhooks.js";

/** Background work: the 6-hourly refresh (profile, picks, season alert, auto-add) and half-hourly airing alerts. */

type Log = (msg: string) => void;

async function refresh(warn: Log) {
  try {
    setJob("refresh", "running", "Refreshing seasons");
    const cur = seasonOf();
    const next = shiftSeason(cur, 1);
    if (getSettings().auth.passwordHash) {
      await getProfile();
      await recommend(cur.season, cur.year);
      await notifySeason(next.season, next.year);
      await runAutoAdd();
    }
    setJob("refresh", "done", "Seasons up to date");
  } catch (e) {
    setJob("refresh", "error", (e as Error).message);
    warn(`Background refresh failed: ${(e as Error).message}`);
  }
}

/** Starts the timers. Returns a stop function that also sends any batched episode alerts (for shutdown). */
export function startJobs(warn: Log) {
  const timers = [
    setTimeout(() => void refresh(warn), 15_000),
    setInterval(() => void refresh(warn), 6 * 3_600_000),
    setInterval(() => void announceAired().catch((e) => warn(`Airing alerts failed: ${(e as Error).message}`)), 30 * 60_000),
  ];
  // A new install with nothing connected will start with the quiz: have it ready.
  const s = getSettings();
  if (!s.sonarr.url && !s.lists.anilistUser && Object.keys(s.genrePrefs).length === 0) timers.push(setTimeout(prewarmQuiz, 3_000));
  return {
    stop() {
      for (const t of timers) clearTimeout(t);
    },
    flush: flushPending,
  };
}
