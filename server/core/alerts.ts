/** Wording of "new episode" alerts. */

export interface EpisodeRef {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
}

export const episodeCode = (e: EpisodeRef) => `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;

/** Title and body for a batch of imported episodes of one series (duplicates removed, in order). */
export function episodeAlert(seriesTitle: string, episodes: EpisodeRef[]) {
  const eps = [...new Map(episodes.map((e) => [episodeCode(e), e])).values()].sort((a, b) => episodeCode(a).localeCompare(episodeCode(b)));
  const body =
    eps.length === 1
      ? `${episodeCode(eps[0])}${eps[0].title ? ` · ${eps[0].title}` : ""} is ready to watch.`
      : eps.length <= 4
        ? `${eps.map(episodeCode).join(", ")} are ready to watch.`
        : `${eps.length} episodes (${episodeCode(eps[0])}–${episodeCode(eps.at(-1)!)}) are ready to watch.`;
  return { title: `${eps.length > 1 ? `${eps.length} new episodes` : "New episode"}: ${seriesTitle}`, body };
}
