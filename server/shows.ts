import { db, droppedSet } from "./db.js";
import { getMediaByIds } from "./anilist.js";
import { signAction } from "./auth.js";
import { anilistIdsForTvdb, mappingTables } from "./mapping.js";
import { watchStates } from "./mediaserver.js";
import { send } from "./notify.js";
import { getSettings } from "./settings.js";
import { sonarrSeries, setMonitored } from "./sonarr.js";

/** "Not into it anymore": remembered for the taste model, mutes alerts, optionally unmonitors in Sonarr. */
export async function dropShow(tvdbId: number) {
  const s = (await sonarrSeries()).find((x) => x.tvdbId === tvdbId);
  const title = s?.title ?? `TVDB ${tvdbId}`;
  db.prepare("INSERT INTO dropped (tvdb_id, title, at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at").run(tvdbId, title, Date.now());
  const unmonitor = !!s && getSettings().sonarr.dropAction === "unmonitor";
  if (unmonitor) await setMonitored(s.id, false);
  return { tvdbId, title, dropped: true, monitored: s ? !unmonitor && s.monitored : null };
}

export async function undropShow(tvdbId: number) {
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  const s = (await sonarrSeries()).find((x) => x.tvdbId === tvdbId);
  const remonitor = !!s && getSettings().sonarr.dropAction === "unmonitor";
  if (remonitor) await setMonitored(s.id, true);
  return { tvdbId, dropped: false, monitored: s ? remonitor || s.monitored : null };
}

async function posterFor(tvdbId: number) {
  const ids = await anilistIdsForTvdb(tvdbId);
  if (!ids.length) return null;
  const media = await getMediaByIds(ids.slice(-3));
  return media.at(-1)?.coverImage.large ?? null;
}

/** Continuing anime in Sonarr with watch progress, for the My Shows page. */
export async function myShows() {
  const [series, watch] = await Promise.all([sonarrSeries(true), watchStates().catch(() => new Map())]);
  const dropped = droppedSet();
  return series
    .filter((s) => s.seriesType === "anime" && (s.status === "continuing" || s.status === "upcoming" || dropped.has(s.tvdbId)))
    .map((s) => {
      const stats = (s.statistics ?? {}) as { episodeFileCount?: number };
      const w = watch.get(s.tvdbId);
      const poster = ((s.images ?? []) as { coverType: string; remoteUrl?: string }[]).find((i) => i.coverType === "poster")?.remoteUrl ?? null;
      return {
        tvdbId: s.tvdbId,
        title: s.title,
        poster,
        monitored: s.monitored,
        nextAiring: (s.nextAiring as string | undefined) ?? null,
        downloaded: stats.episodeFileCount ?? 0,
        watched: w?.watched ?? null,
        total: w?.total ?? null,
        dropped: dropped.has(s.tvdbId),
      };
    })
    .sort((a, b) => Number(a.dropped) - Number(b.dropped) || (a.nextAiring ?? "9").localeCompare(b.nextAiring ?? "9"));
}

interface SonarrWebhook {
  eventType: string;
  isUpgrade?: boolean;
  series?: { title: string; tvdbId: number; type?: string; images?: { coverType: string; remoteUrl?: string }[] };
  episodes?: { seasonNumber: number; episodeNumber: number; title?: string }[];
}

const code = (e: { seasonNumber: number; episodeNumber: number }) => `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;

/** Sonarr sends one webhook per imported file; collect them per series for a minute so a batch drop is one alert. */
const pending = new Map<number, { series: NonNullable<SonarrWebhook["series"]>; episodes: NonNullable<SonarrWebhook["episodes"]>; timer: NodeJS.Timeout }>();
const BATCH_MS = 60_000;

async function flush(tvdbId: number) {
  const p = pending.get(tvdbId);
  pending.delete(tvdbId);
  if (!p || droppedSet().has(tvdbId)) return;
  const eps = [...new Map(p.episodes.map((e) => [code(e), e])).values()].sort((a, b) => code(a).localeCompare(code(b)));
  const body =
    eps.length === 1
      ? `${code(eps[0])}${eps[0].title ? ` · ${eps[0].title}` : ""} is ready to watch.`
      : eps.length <= 4
        ? `${eps.map(code).join(", ")} are ready to watch.`
        : `${eps.length} episodes (${code(eps[0])}–${code(eps.at(-1)!)}) are ready to watch.`;
  const ext = getSettings().externalUrl;
  const { exp, sig } = signAction("drop", tvdbId);
  await send({
    title: `${eps.length > 1 ? `${eps.length} new episodes` : "New episode"}: ${p.series.title}`,
    body,
    image: p.series.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? (await posterFor(tvdbId).catch(() => null)),
    url: ext ? `${ext}/shows` : undefined,
    actions: ext ? [{ label: "Not into it anymore", url: `${ext}/api/actions/drop/${tvdbId}?exp=${exp}&sig=${sig}` }] : undefined,
  }).catch((e) => console.warn("Episode alert failed:", (e as Error).message));
}

interface RadarrWebhook {
  eventType: string;
  isUpgrade?: boolean;
  movie?: { title: string; year?: number; tmdbId: number; images?: { coverType: string; remoteUrl?: string }[] };
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
    cur.timer.refresh();
  } else {
    pending.set(id, { series: p.series, episodes: [...(p.episodes ?? [])], timer: setTimeout(() => void flush(id), BATCH_MS) });
  }
  return ["queued"];
}
