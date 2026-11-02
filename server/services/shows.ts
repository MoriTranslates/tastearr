import type { Show } from "../../shared/api.js";
import { addDropped, droppedSet, removeDropped } from "../data/library.js";
import { cachedWatch } from "./context.js";
import { getSettings } from "./settings.js";
import { setMonitored, sonarrSeries } from "./sonarr.js";

/** My Shows: continuing anime in Sonarr with watch progress, and "not into it anymore". */

/** "Not into it anymore": remembered for the taste model, mutes alerts, optionally unmonitors in Sonarr. */
export async function dropShow(tvdbId: number) {
  const s = (await sonarrSeries()).find((x) => x.tvdbId === tvdbId);
  const title = s?.title ?? `TVDB ${tvdbId}`;
  addDropped(tvdbId, title);
  const unmonitor = !!s && getSettings().sonarr.dropAction === "unmonitor";
  if (unmonitor) await setMonitored(s.id, false, s.instance);
  return { tvdbId, title, dropped: true, monitored: s ? !unmonitor && s.monitored : null };
}

export async function undropShow(tvdbId: number) {
  removeDropped(tvdbId);
  const s = (await sonarrSeries()).find((x) => x.tvdbId === tvdbId);
  const remonitor = !!s && getSettings().sonarr.dropAction === "unmonitor";
  if (remonitor) await setMonitored(s.id, true, s.instance);
  return { tvdbId, dropped: false, monitored: s ? remonitor || s.monitored : null };
}

/** Continuing anime in Sonarr with watch progress, for the My Shows page. */
export async function myShows(): Promise<Show[]> {
  const [series, watch] = await Promise.all([sonarrSeries(true), cachedWatch().catch(() => new Map())]);
  const dropped = droppedSet();
  return series
    .filter((s) => s.seriesType === "anime" && (s.status === "continuing" || s.status === "upcoming" || dropped.has(s.tvdbId)))
    .map((s) => {
      const stats = (s.statistics ?? {}) as { episodeFileCount?: number };
      const w = watch.get(s.tvdbId);
      const poster =
        ((s.images ?? []) as { coverType: string; remoteUrl?: string }[]).find((i) => i.coverType === "poster")?.remoteUrl ?? null;
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
