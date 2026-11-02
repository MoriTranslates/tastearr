import { episodeAlert, type EpisodeRef } from "../core/alerts.js";
import { completeAlert, dropAlert, failedAlert, pendingAlert, pendingAlerts, queueAlert } from "../data/alerts.js";
import { droppedSet } from "../data/library.js";
import { getMediaByIds } from "./catalog.js";
import { anilistIdsForTvdb, mappingTables } from "./mapping.js";
import { send } from "./notify.js";
import { signAction } from "./sessions.js";
import { getSettings } from "./settings.js";

/**
 * Sonarr/Radarr "On Import" webhooks: "new episode" / "movie ready" alerts, batched per series. Batches live in SQLite
 * (data/alerts.ts) so a crash or kill doesn't lose them: they are sent on the next start. Delivery is at-least-once:
 * a crash in the instant between a successful send and removing the batch sends that one alert twice on restart.
 */

interface SonarrWebhook {
  eventType: string;
  isUpgrade?: boolean;
  series?: { title: string; tvdbId: number; type?: string; images?: { coverType: string; remoteUrl?: string }[] };
  episodes?: EpisodeRef[];
}

interface RadarrWebhook {
  eventType: string;
  isUpgrade?: boolean;
  movie?: { title: string; year?: number; tmdbId: number; images?: { coverType: string; remoteUrl?: string }[] };
}

type Series = NonNullable<SonarrWebhook["series"]>;

/**
 * Sonarr sends one webhook per imported file; collect them per series for a minute so a batch drop is one alert, and a
 * long import backlog still gets its alert within 5 minutes. A failed send is retried a few times, then given up.
 */
export const ALERT_BATCH = { batchMs: 60_000, maxBatchMs: 5 * 60_000, retryMs: 5 * 60_000, maxAttempts: 3, startDelayMs: 10_000 };

const timers = new Map<number, NodeJS.Timeout>();
const sending = new Map<number, Promise<void>>();

/** (Re)arms a series' send timer. Unref'd: a waiting batch never keeps the process alive, it is in the database. */
function schedule(tvdbId: number, dueAt: number) {
  clearTimeout(timers.get(tvdbId));
  const t = setTimeout(
    () => {
      timers.delete(tvdbId);
      void flush(tvdbId);
    },
    Math.max(0, dueAt - Date.now()),
  );
  t.unref();
  timers.set(tvdbId, t);
}

async function posterFor(tvdbId: number) {
  const ids = await anilistIdsForTvdb(tvdbId);
  if (!ids.length) return null;
  const media = await getMediaByIds(ids.slice(-3));
  return media.at(-1)?.coverImage.large ?? null;
}

/** Sends one series' batch. Concurrent calls (timer and shutdown at once) share a single send. */
function flush(tvdbId: number): Promise<void> {
  const cur = sending.get(tvdbId);
  if (cur) return cur;
  const p = sendBatch(tvdbId).finally(() => sending.delete(tvdbId));
  sending.set(tvdbId, p);
  return p;
}

async function sendBatch(tvdbId: number) {
  const p = pendingAlert<Series, EpisodeRef>(tvdbId);
  if (!p) return;
  if (droppedSet().has(tvdbId) || !p.episodes.length) return dropAlert(tvdbId);
  const { title, body } = episodeAlert(p.series.title, p.episodes);
  const ext = getSettings().externalUrl;
  const { exp, sig } = signAction("drop", tvdbId);
  try {
    await send({
      title,
      body,
      // The poster is decoration: without one (AniList down, no mapping) the alert still goes out.
      image: p.series.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? (await posterFor(tvdbId).catch(() => null)),
      url: ext ? `${ext}/shows` : undefined,
      actions: ext ? [{ label: "Not into it anymore", url: `${ext}/api/actions/drop/${tvdbId}?exp=${exp}&sig=${sig}` }] : undefined,
    });
  } catch (e) {
    const attempts = failedAlert(tvdbId, Date.now() + ALERT_BATCH.retryMs);
    if (attempts >= ALERT_BATCH.maxAttempts) {
      console.warn(`Episode alert for ${p.series.title} failed ${attempts} times, giving up: ${(e as Error).message}`);
      dropAlert(tvdbId);
    } else {
      console.warn(`Episode alert for ${p.series.title} failed, will retry: ${(e as Error).message}`);
      schedule(tvdbId, Date.now() + ALERT_BATCH.retryMs);
    }
    return;
  }
  // Episodes that arrived while sending stay queued with their own timer.
  const rest = completeAlert<Series, EpisodeRef>(tvdbId, p.rev, p.episodes);
  if (rest && !timers.has(tvdbId)) schedule(tvdbId, rest.dueAt);
}

/**
 * Sends every batch still waiting, including ones left in the database by a previous run (on shutdown, so a restart
 * doesn't swallow "new episode" alerts). Returns how many batches it tried.
 */
export async function flushPending() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  const ids = pendingAlerts().map((a) => a.tvdbId);
  await Promise.all(ids.map((id) => flush(id)));
  return ids.length;
}

/** On start: re-arms batches a crash or kill left behind (sent shortly after start, once the network is up). */
export function resumePendingAlerts() {
  const left = pendingAlerts();
  for (const a of left) schedule(a.tvdbId, Math.max(a.dueAt, Date.now() + ALERT_BATCH.startDelayMs));
  return left.length;
}

/** Radarr Connect -> Webhook (On Import). Only alerts for movies Tastearr knows as anime. */
export async function handleRadarrWebhook(p: RadarrWebhook) {
  if (p.eventType === "Test") return send({ title: "Tastearr", body: "Radarr webhook connected. Movie alerts will show up here." });
  if (p.eventType !== "Download" || p.isUpgrade || !p.movie || !getSettings().notify.episodeAlerts) return [];
  const { anilistByMovie } = await mappingTables();
  if (!anilistByMovie.has(p.movie.tmdbId)) return [];
  return send({
    title: `Movie ready: ${p.movie.title}`,
    body: `${p.movie.title}${p.movie.year ? ` (${p.movie.year})` : ""} is ready to watch.`,
    image: p.movie.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? null,
  });
}

const validEpisode = (e: EpisodeRef) => Number.isInteger(e?.seasonNumber) && Number.isInteger(e?.episodeNumber);

/** Sonarr Connect -> Webhook (On Import). Pushes "new episode" alerts for anime the user hasn't dropped. */
export async function handleSonarrWebhook(p: SonarrWebhook) {
  if (p.eventType === "Test") return send({ title: "Tastearr", body: "Sonarr webhook connected. New episode alerts will show up here." });
  if (p.eventType !== "Download" || p.isUpgrade || !p.series || !getSettings().notify.episodeAlerts) return [];
  if (p.series.type && p.series.type !== "anime") return [];
  const id = Number(p.series.tvdbId);
  if (!Number.isInteger(id) || id <= 0 || droppedSet().has(id)) return [];
  const { batchMs, maxBatchMs } = ALERT_BATCH;
  const now = Date.now();
  const a = queueAlert<Series, EpisodeRef>(id, p.series, (p.episodes ?? []).filter(validEpisode), (cur) =>
    !cur ? now + batchMs : now - cur.firstAt < maxBatchMs - batchMs ? now + batchMs : cur.dueAt,
  );
  schedule(id, a.dueAt);
  return ["queued"];
}
