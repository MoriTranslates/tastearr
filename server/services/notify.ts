import { sendDiscord, sendGotify, sendNtfy, type Message } from "../adapters/notify.js";
import type { Season } from "../core/taste/media.js";
import { markSeasonAnnounced, seasonAnnounced } from "../data/library.js";
import { recommend } from "./picks.js";
import { getSettings } from "./settings.js";

/** Alerts to whichever channels are set up, and the once-a-season "your picks" message. */

export type { Message };

/** Sends to every configured channel. Returns the channels that worked; throws only if all failed. */
export async function send(m: Message) {
  const n = getSettings().notify;
  const jobs: [string, () => Promise<void>][] = [];
  if (n.discordWebhook) jobs.push(["discord", () => sendDiscord(n.discordWebhook, m)]);
  if (n.ntfyUrl) jobs.push(["ntfy", () => sendNtfy(n.ntfyUrl, n.ntfyToken, m)]);
  if (n.gotifyUrl && n.gotifyToken) jobs.push(["gotify", () => sendGotify(n.gotifyUrl, n.gotifyToken, m)]);
  if (!jobs.length) return [];
  const results = await Promise.allSettled(jobs.map(([, f]) => f()));
  const ok = jobs.filter((_, i) => results[i].status === "fulfilled").map(([name]) => name);
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as Error).message);
  if (errors.length) console.warn("Notification errors:", errors.join("; "));
  if (!ok.length) throw new Error(errors.join("; "));
  return ok;
}

/** An alert channel is set up. */
export function canNotify() {
  const n = getSettings().notify;
  return !!(n.ntfyUrl || n.discordWebhook || (n.gotifyUrl && n.gotifyToken));
}

const cap = (s: string) => s[0] + s.slice(1).toLowerCase();

/**
 * Sends the top picks for a season once. Returns true if a message was sent. Throws without sending (and without
 * marking the season announced) when a source couldn't be read: owned shows would look new, and the correct alert
 * would never go out.
 */
export async function notifySeason(season: Season, year: number, force = false) {
  const n = getSettings().notify;
  if (!force && (!n.seasonAlerts || seasonAnnounced(season, year))) return false;
  const { picks, degraded, partial } = await recommend(season, year);
  if (degraded.length) throw new Error(`Season alert skipped because a source couldn't be read: ${degraded.join("; ")}`);
  if (partial.length)
    throw new Error(
      `Season alert skipped: the taste profile is partial (built without ${partial.join(", ")}); it waits for a complete build`,
    );
  // New to the user only: nothing they already have, rated, follow, watch or carry over from last season.
  const top = picks.filter((p) => !p.excluded && !p.inLibrary && !p.verdict && !p.myStatus && !p.carryOver).slice(0, n.picks);
  if (top.length < Math.min(n.picks, 5)) return false; // season line-up not announced yet
  const ext = getSettings().externalUrl;
  const sent = await send({
    title: `Your ${cap(season)} ${year} anime picks`,
    body: top.map((p, i) => `${i + 1}. ${p.title} (${p.match}%)${p.similar ? ` · like ${p.similar}` : ""}`).join("\n"),
    url: ext ? `${ext}/?season=${season}&year=${year}` : top[0].siteUrl,
    image: top[0].cover,
  });
  if (sent.length) markSeasonAnnounced(season, year);
  return sent.length > 0;
}
