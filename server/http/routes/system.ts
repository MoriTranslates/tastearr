import type { FastifyInstance } from "fastify";
import type { ProfileResponse } from "../../../shared/api.js";
import { checkPassword } from "../../core/secrets.js";
import { invalidateContext } from "../../services/context.js";
import { backupStream, healthChecks, listJobs, systemInfo } from "../../services/health.js";
import { clearOverrides } from "../../services/mapping.js";
import { rebuildProfile, storedProfile } from "../../services/profile.js";
import { getSettings } from "../../services/settings.js";
import { authState, loginAllowed, loginSucceeded } from "../auth.js";
import { fail } from "../util.js";

/** The taste profile, background jobs, health, backups and match reset. */
export function systemRoutes(app: FastifyInstance) {
  app.get("/api/profile", async (): Promise<ProfileResponse> => {
    const p = storedProfile();
    if (p) return p;
    void rebuildProfile().catch(() => undefined);
    return { building: true };
  });
  app.post("/api/profile/rebuild", async () => {
    void rebuildProfile().catch(() => undefined);
    // The build that's running now (it may have started earlier, e.g. right after a list import): the UI follows this one.
    return { started: true, startedAt: listJobs().find((j) => j.name === "profile")?.startedAt ?? Date.now() };
  });
  app.get("/api/system", async () => systemInfo());
  app.get("/api/system/health", async () => healthChecks());

  /** A copy of the database (settings, keys, taste data). It contains every secret, so it asks for the password again. */
  app.post<{ Body: { password?: string } }>("/api/system/backup", async (req, reply) => {
    // The password itself authorises this (so home-network-bypass users can back up too); the admin key alone can't.
    if (authState(req).via === "apikey") throw fail("Backups need the account password", 403);
    if (!loginAllowed(req.ip, getSettings().auth.username)) throw fail("Too many attempts, wait a few seconds and try again", 429);
    if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
    loginSucceeded(req.ip, getSettings().auth.username);
    const data = backupStream();
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="tastearr-backup-${stamp}.db"`)
      .send(data);
  });

  /** Forgets matches picked by hand; the community list applies again. */
  app.post("/api/mapping/reset", async (req) => {
    if (authState(req).via !== "session") throw fail("Log in with your password to reset matches", 403);
    const n = clearOverrides();
    invalidateContext();
    return { cleared: n };
  });
}
