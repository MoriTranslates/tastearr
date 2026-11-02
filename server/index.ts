import { PORT } from "./config.js";
import { closeDb } from "./data/db.js";
import { app } from "./http/app.js";
import { SETUP_TOKEN } from "./http/auth.js";
import { startJobs } from "./services/jobs.js";
import { getSettings } from "./services/settings.js";

/** Starts Tastearr: the web server, the background jobs, and a clean shutdown. */

const jobs = startJobs((msg) => app.log.warn(msg));

/**
 * `docker stop` / an Unraid update sends SIGTERM. Node running as PID 1 ignores it by default, so the container was
 * killed 10 seconds later and episode alerts still being batched were lost. Send them now, then exit.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal} received, shutting down`);
  jobs.stop();
  const deadline = () => new Promise((r) => setTimeout(r, 7_000).unref());
  await Promise.race([jobs.flush().catch(() => undefined), deadline()]);
  await Promise.race([app.close().catch(() => undefined), deadline()]);
  closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: PORT });
if (!getSettings().auth.passwordHash)
  app.log.warn(
    `No account yet. Open Tastearr from your home network to create one, or use setup code ${SETUP_TOKEN} from elsewhere (one-time, changes on restart, safe to redact from shared logs).`,
  );
