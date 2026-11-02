import fs from "node:fs";
import type { Status } from "../../shared/api.js";
import { VERSION } from "../config.js";
import { seasonOf } from "../core/taste/media.js";
import { snapshotDatabase } from "../data/backup.js";
import { listJobs } from "../data/jobs.js";
import { mappingFileAge } from "./mapping.js";
import { testMediaServer } from "./mediaserver.js";
import { isBuilding, storedProfile } from "./profile.js";
import { testRadarr } from "./radarr.js";
import { getSettings } from "./settings.js";
import { testSonarr } from "./sonarr.js";

/** App status, setup warnings, System -> Health checks, background job list and database backups. */

export { listJobs };

const STARTED = Date.now();

/** Things noticed while serving requests that deserve a banner. */
const seen = {
  /** Last call to the v0.1 webhook address (key in the URL). */
  legacyWebhookAt: 0,
  /** A reverse proxy is in front but TRUST_PROXY isn't set. */
  proxy: false,
  /** Last webhook from each app since startup. */
  webhook: {} as Record<string, number>,
};

export const noteLegacyWebhook = () => void (seen.legacyWebhookAt = Date.now());
export const noteProxy = () => void (seen.proxy = true);
/** A webhook arrived on the current address; for Sonarr that also clears the old-address warning. */
export function noteWebhook(app: "sonarr" | "radarr") {
  seen.webhook[app] = Date.now();
  if (app === "sonarr") seen.legacyWebhookAt = 0;
}

/** Problems worth a banner (also listed under System -> Health). */
export function warnings() {
  const out: string[] = [];
  if (seen.legacyWebhookAt)
    out.push(
      "Sonarr is still using the old webhook address, which has a key in the URL. Copy the new one from Settings → Alerts into Sonarr's Connect → Webhook.",
    );
  if (seen.proxy)
    out.push(
      "If you use a reverse proxy, set the TRUST_PROXY variable to your proxy's IP address (not a hop count) so login protection sees real client addresses.",
    );
  return out;
}

/** GET /api/status for a signed-in user (the caller adds version, setup and login state). */
export function signedInStatus(): Omit<Status, "version" | "setupRequired" | "loggedIn" | "via"> {
  const s = getSettings();
  return {
    sonarr: !!(s.sonarr.url && s.sonarr.apiKey),
    radarr: !!(s.radarr.url && s.radarr.apiKey),
    media: s.media.type !== "none" && !!s.media.url && !!s.media.token,
    lists: !!(s.lists.anilistUser || s.lists.malUser),
    quizAnswers: Object.keys(s.genrePrefs).length,
    alerts: !!(s.notify.ntfyUrl || (s.notify.gotifyUrl && s.notify.gotifyToken) || s.notify.discordWebhook),
    mode: s.mode,
    profileBuiltAt: storedProfile()?.builtAt ?? null,
    building: isBuilding(),
    prefs: {
      hideInLibrary: s.filters.hideInLibrary,
      hideShorts: s.filters.hideShorts,
      services: s.display.services,
      dropAction: s.sonarr.dropAction,
    },
    warnings: warnings(),
    season: seasonOf(),
  };
}

export const systemInfo = () => ({ version: VERSION, uptime: Date.now() - STARTED, node: process.version, jobs: listJobs() });

/** Like Sonarr's System -> Status -> Health: each connection and background job, with a plain-language fix. */
export async function healthChecks() {
  const s = getSettings();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const probe = async (name: string, on: boolean, fn: () => Promise<unknown>, fix: string) => {
    if (!on) return;
    try {
      await fn();
      checks.push({ name, ok: true, detail: "Connected" });
    } catch (e) {
      checks.push({ name, ok: false, detail: `${(e as Error).message}. ${fix}` });
    }
  };
  await Promise.all([
    probe(
      "Sonarr",
      !!(s.sonarr.url && s.sonarr.apiKey),
      () => testSonarr(s.sonarr),
      "Check the address and API key in Settings → Connections.",
    ),
    ...s.sonarrExtra.map((x) => probe(`Sonarr (${x.name})`, true, () => testSonarr(x), "Check it in Settings → Connections.")),
    probe(
      "Radarr",
      !!(s.radarr.url && s.radarr.apiKey),
      () => testRadarr(s.radarr),
      "Check the address and API key in Settings → Connections.",
    ),
    probe(
      s.media.type === "plex" ? "Plex" : "Jellyfin",
      s.media.type !== "none" && !!s.media.url,
      () => testMediaServer(s.media),
      "Sign in again in Settings → Connections.",
    ),
  ]);
  const age = mappingFileAge();
  const fresh = age !== null && age < 14 * 86_400_000;
  checks.push({
    name: "Anime ID list",
    ok: fresh,
    detail:
      age === null
        ? "Not downloaded yet; it's fetched from GitHub on the first picks load."
        : fresh
          ? `Updated ${Math.round(age / 86_400_000)} days ago`
          : "Couldn't refresh from GitHub for over two weeks; new shows may lack Sonarr matches.",
  });
  for (const j of listJobs())
    if (j.state === "error") checks.push({ name: `Background job: ${j.name}`, ok: false, detail: String(j.detail ?? "") });
  for (const w of warnings()) checks.push({ name: "Setup", ok: false, detail: w });
  for (const app of ["sonarr", "radarr"] as const) {
    if (!(s[app].url && s[app].apiKey)) continue;
    const at = seen.webhook[app];
    const name = `${app === "sonarr" ? "Sonarr" : "Radarr"} webhook`;
    if (!at)
      checks.push({
        name,
        ok: true,
        detail:
          "Not heard from since Tastearr started. That's normal until something downloads; if alerts never arrive, add the webhook from Settings → Alerts.",
      });
    else checks.push({ name, ok: true, detail: `Last heard from ${Math.round((Date.now() - at) / 3_600_000)} hours ago` });
  }
  return { checks };
}

/** A copy of the database as a stream; the temporary copy is deleted once sent (or the download is aborted). */
export function backupStream() {
  const tmp = snapshotDatabase();
  const data = fs.createReadStream(tmp);
  data.on("close", () => fs.rmSync(tmp, { force: true }));
  return data;
}
