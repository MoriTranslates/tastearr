import { seasonOf, shiftSeason } from "./anilist.js";
import { app } from "./app.js";
import { SETUP_TOKEN } from "./auth.js";
import { runAutoAdd } from "./autoadd.js";
import { db, setJob } from "./db.js";
import { announceAired } from "./following.js";
import { notifySeason } from "./notify.js";
import { prewarmQuiz } from "./quiz.js";
import { getSettings } from "./settings.js";
import { flushPending } from "./shows.js";
import { getProfile, recommend } from "./taste.js";

const PORT = Number(process.env.PORT ?? 8383);

// ---------------------------------------------------------------- background: refresh, rebuild, announce

async function tick() {
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
    app.log.warn(`Background refresh failed: ${(e as Error).message}`);
  }
}
const timers = [
  setTimeout(tick, 15_000),
  setInterval(tick, 6 * 3_600_000),
  setInterval(() => void announceAired().catch((e) => app.log.warn(`Airing alerts failed: ${(e as Error).message}`)), 30 * 60_000),
];
// A new install with nothing connected will start with the quiz: have it ready.
if (!getSettings().sonarr.url && !getSettings().lists.anilistUser && Object.keys(getSettings().genrePrefs).length === 0)
  timers.push(setTimeout(prewarmQuiz, 3_000));

/**
 * `docker stop` / an Unraid update sends SIGTERM. Node running as PID 1 ignores it by default, so the container was
 * killed 10 seconds later and episode alerts still being batched were lost. Send them now, then exit.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal} received, shutting down`);
  for (const t of timers) clearTimeout(t);
  const deadline = () => new Promise((r) => setTimeout(r, 7_000).unref());
  await Promise.race([flushPending().catch(() => undefined), deadline()]);
  await Promise.race([app.close().catch(() => undefined), deadline()]);
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: PORT });
if (!getSettings().auth.passwordHash)
  app.log.warn(
    `No account yet. Open Tastearr from your home network to create one, or use setup code ${SETUP_TOKEN} from elsewhere (one-time, changes on restart, safe to redact from shared logs).`,
  );
