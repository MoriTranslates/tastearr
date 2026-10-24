import { db, droppedSet } from "./db.js";
import { getMediaByIds } from "./anilist.js";
import { anilistIdsForTvdb } from "./mapping.js";
import { watchStates } from "./mediaserver.js";
import { send } from "./notify.js";
import { getSettings } from "./settings.js";
import { sonarrSeries, setMonitored } from "./sonarr.js";

/** "Not into it anymore": remembered for the taste model, mutes alerts, optionally unmonitors in Sonarr. */
export async function dropShow(tvdbId: number) {
  const s = (await sonarrSeries()).find((x) => x.tvdbId === tvdbId);
  const title = s?.title ?? `TVDB ${tvdbId}`;
  db.prepare("INSERT INTO dropped (tvdb_id, title, at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET at = excluded.at").run(tvdbId, title, Date.now());
  if (s && getSettings().sonarr.dropAction === "unmonitor") await setMonitored(s.id, false);
  return { tvdbId, title };
}

export async function undropShow(tvdbId: number) {
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  const s = (await sonarrSeries()).find((x) => x.tvdbId === tvdbId);
  if (s && getSettings().sonarr.dropAction === "unmonitor") await setMonitored(s.id, true);
  return { tvdbId };
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
    .filter((s) => s.seriesType === "anime" && (s.status === "continuing" || dropped.has(s.tvdbId)))
    .map((s) => {
      const stats = (s.statistics ?? {}) as { episodeFileCount?: number };
      const w = watch.get(s.tvdbId);
      const poster = ((s.images ?? []) as { coverType: string; remoteUrl?: string }[]).find((i) => i.coverType === "poster")?.remoteUrl ?? null;
      return {
        tvdbId: s.tvdbId,
        title: s.title,
        poster,
        monitored: s.monitored as boolean,
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
  series?: { title: string; tvdbId: number; images?: { coverType: string; remoteUrl?: string }[] };
  episodes?: { seasonNumber: number; episodeNumber: number; title?: string }[];
}

/** Sonarr Connect -> Webhook (On Import). Pushes a "new episode" alert unless the show was dropped. */
export async function handleSonarrWebhook(p: SonarrWebhook) {
  const n = getSettings().notify;
  if (p.eventType === "Test") return send({ title: "Tastearr", body: "Sonarr webhook connected. New episode alerts will show up here." });
  if (p.eventType !== "Download" || p.isUpgrade || !p.series || !n.episodeAlerts) return [];
  if (droppedSet().has(p.series.tvdbId)) return [];
  const eps = p.episodes ?? [];
  const code = eps.map((e) => `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`).join(", ");
  const epTitle = eps.length === 1 && eps[0].title ? ` · ${eps[0].title}` : "";
  const ext = getSettings().externalUrl;
  const key = getSettings().apiKey;
  return send({
    title: `New episode: ${p.series.title}`,
    body: `${code}${epTitle} is ready to watch.`,
    image: p.series.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? (await posterFor(p.series.tvdbId)),
    url: ext ? `${ext}/shows` : undefined,
    actions: ext ? [{ label: "Not into it anymore", url: `${ext}/api/shows/${p.series.tvdbId}/drop?apikey=${key}` }] : undefined,
  });
}
