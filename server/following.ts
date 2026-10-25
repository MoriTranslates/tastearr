import { db } from "./db.js";
import { airedBetween, getMediaByIds, type Media } from "./anilist.js";
import { send } from "./notify.js";
import { getSettings } from "./settings.js";
import { setFeedback, streamingLinks, title } from "./taste.js";

/**
 * Follow list for people who watch on streaming services instead of (or as well as) running Sonarr.
 * Followed shows count as picks for the taste model, show up in My Shows, and get "episode N is out"
 * alerts from AniList's airing schedule with a link to where it streams.
 */

export function followedIds(): number[] {
  return (db.prepare("SELECT anilist_id FROM following").all() as { anilist_id: number }[]).map((r) => r.anilist_id);
}

export async function follow(id: number) {
  const [m] = await getMediaByIds([id]);
  if (!m) throw Object.assign(new Error("Unknown show"), { statusCode: 404 });
  db.prepare("INSERT INTO following (anilist_id, title, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(id, title(m), Date.now());
  // Don't announce episodes that aired before following.
  if (m.nextAiringEpisode) for (let ep = 1; ep < m.nextAiringEpisode.episode; ep++) db.prepare("INSERT OR IGNORE INTO aired_notified (anilist_id, episode) VALUES (?, ?)").run(id, ep);
  setFeedback(id, "added");
  return { id, following: true };
}

export function unfollow(id: number) {
  db.prepare("DELETE FROM following WHERE anilist_id = ?").run(id);
  return { id, following: false };
}

export async function followedShows() {
  const ids = followedIds();
  const media = await getMediaByIds(ids);
  return media.map((m: Media) => ({
    id: m.id,
    title: title(m),
    cover: m.coverImage.large,
    siteUrl: m.siteUrl,
    status: m.status,
    episodes: m.episodes,
    nextAiring: m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt * 1000, episode: m.nextAiringEpisode.episode } : null,
    streaming: streamingLinks(m),
  }));
}

/** Announces newly aired episodes of followed shows. Runs hourly; looks back 2 days so nothing is missed. */
export async function announceAired() {
  const n = getSettings().notify;
  if (!n.airingAlerts) return 0;
  const ids = followedIds();
  if (!ids.length) return 0;
  // Simulcasts usually land a little after the Japanese broadcast; wait before saying "it's out".
  const now = Math.floor(Date.now() / 1000) - n.airingDelayMin * 60;
  const aired = await airedBetween(ids, now - 2 * 86400, now);
  const seen = db.prepare("SELECT 1 FROM aired_notified WHERE anilist_id = ? AND episode = ?");
  const fresh = aired.filter((a) => !seen.get(a.mediaId, a.episode));
  if (!fresh.length) return 0;
  const media = new Map((await getMediaByIds([...new Set(fresh.map((a) => a.mediaId))])).map((m) => [m.id, m]));
  for (const a of fresh) {
    const m = media.get(a.mediaId);
    if (!m) continue;
    const where = [...new Set((m.externalLinks ?? []).filter((l) => l.type === "STREAMING").map((l) => l.site.replace(/^Amazon Prime Video$/, "Prime Video")))];
    const firstUrl = (m.externalLinks ?? []).find((l) => l.type === "STREAMING")?.url;
    try {
      const sent = await send({
        title: `${title(m)}: episode ${a.episode} is out`,
        body: where.length ? `Aired in Japan. Usually on ${where.slice(0, 3).join(", ")} soon after.` : "It just aired in Japan.",
        url: firstUrl ?? m.siteUrl,
        image: m.coverImage.large,
      });
      // Only remember it as announced once an alert actually went out, so an ntfy outage doesn't lose it.
      if (sent.length) db.prepare("INSERT OR IGNORE INTO aired_notified (anilist_id, episode) VALUES (?, ?)").run(a.mediaId, a.episode);
    } catch (e) {
      console.warn("Airing alert failed, will retry:", (e as Error).message);
    }
  }
  return fresh.length;
}
