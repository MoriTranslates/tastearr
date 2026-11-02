import { likedSince } from "../data/feedback.js";
import { cachedMedia } from "./catalog.js";
import { titleOf } from "./context.js";
import { mappingTables } from "./mapping.js";

/**
 * Import lists, for people who'd rather Sonarr/Radarr pull picks than let Tastearr write to them. Sonarr's "Custom
 * List" reads [{ tvdbId }]; Radarr's "Custom List" reads [{ id }] (TMDB). Lists shows given 👍 or ♥ on the Picks page.
 */

const wanted = () => likedSince(Date.now() - 120 * 86_400_000);
const listTitle = (id: number) => {
  const m = cachedMedia(id);
  return m ? titleOf(m) : undefined;
};

export async function sonarrImportList() {
  const t = await mappingTables();
  const out = new Map<number, string | undefined>();
  for (const a of wanted()) {
    const tvdbId = t.byAnilist.get(a)?.tvdbId;
    if (tvdbId && !out.has(tvdbId)) out.set(tvdbId, listTitle(a));
  }
  return [...out].map(([tvdbId, title]) => ({ tvdbId, title }));
}

export async function radarrImportList() {
  const t = await mappingTables();
  const out = new Map<number, string | undefined>();
  for (const a of wanted()) {
    const tmdb = t.movieByAnilist.get(a);
    if (tmdb && !out.has(tmdb)) out.set(tmdb, listTitle(a));
  }
  return [...out].map(([id, title]) => ({ id, title }));
}
