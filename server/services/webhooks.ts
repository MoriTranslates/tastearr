import { episodeAlert, type EpisodeRef } from "../core/alerts.js";
import { droppedSet } from "../data/library.js";
import { getMediaByIds } from "./catalog.js";
import { anilistIdsForTvdb, mappingTables } from "./mapping.js";
import { send } from "./notify.js";
import { signAction } from "./sessions.js";
import { getSettings } from "./settings.js";

/** Sonarr/Radarr "On Import" webhooks: "new episode" / "movie ready" alerts, batched per series. */

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

async function posterFor(tvdbId: number) {
  const ids = await anilistIdsForTvdb(tvdbId);
  if (!ids.length) return null;
  const media = await getMediaByIds(ids.slice(-3));
  return media.at(-1)?.coverImage.large ?? null;
}

/** Sonarr sends one webhook per imported file; collect them per series for a minute so a batch drop is one alert. */
const pending = new Map<
  number,
  { series: NonNullable<SonarrWebhook["series"]>; episodes: EpisodeRef[]; timer: NodeJS.Timeout; first: number }
>();
const BATCH_MS = 60_000;
/** A long import backlog still gets its alert within 5 minutes. */
const MAX_BATCH_MS = 5 * 60_000;

async function flush(tvdbId: number) {
  const p = pending.get(tvdbId);
  pending.delete(tvdbId);
  if (!p || droppedSet().has(tvdbId)) return;
  const { title, body } = episodeAlert(p.series.title, p.episodes);
  const ext = getSettings().externalUrl;
  const { exp, sig } = signAction("drop", tvdbId);
  await send({
    title,
    body,
    image: p.series.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? (await posterFor(tvdbId).catch(() => null)),
    url: ext ? `${ext}/shows` : undefined,
    actions: ext ? [{ label: "Not into it anymore", url: `${ext}/api/actions/drop/${tvdbId}?exp=${exp}&sig=${sig}` }] : undefined,
  }).catch((e) => console.warn("Episode alert failed:", (e as Error).message));
}

/** Sends every batch still waiting (on shutdown, so a restart doesn't swallow "new episode" alerts). */
export async function flushPending() {
  const ids = [...pending.keys()];
  for (const id of ids) clearTimeout(pending.get(id)!.timer);
  await Promise.all(ids.map((id) => flush(id)));
  return ids.length;
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

/** Sonarr Connect -> Webhook (On Import). Pushes "new episode" alerts for anime the user hasn't dropped. */
export async function handleSonarrWebhook(p: SonarrWebhook) {
  if (p.eventType === "Test") return send({ title: "Tastearr", body: "Sonarr webhook connected. New episode alerts will show up here." });
  if (p.eventType !== "Download" || p.isUpgrade || !p.series || !getSettings().notify.episodeAlerts) return [];
  if (p.series.type && p.series.type !== "anime") return [];
  if (droppedSet().has(p.series.tvdbId)) return [];
  const id = p.series.tvdbId;
  const cur = pending.get(id);
  if (cur) {
    cur.episodes.push(...(p.episodes ?? []));
    if (Date.now() - cur.first < MAX_BATCH_MS - BATCH_MS) cur.timer.refresh();
  } else {
    pending.set(id, {
      series: p.series,
      episodes: [...(p.episodes ?? [])],
      timer: setTimeout(() => void flush(id), BATCH_MS),
      first: Date.now(),
    });
  }
  return ["queued"];
}
