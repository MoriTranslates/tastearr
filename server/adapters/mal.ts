/** MyAnimeList API v2: a user's public anime list. */

export interface MalEntry {
  malId: number;
  status: string;
  /** 0-10, 0 = unscored. */
  score: number;
  episodesWatched: number;
}

export async function malUserList(user: string, clientId: string): Promise<MalEntry[]> {
  const out: MalEntry[] = [];
  let url: string | null =
    `https://api.myanimelist.net/v2/users/${encodeURIComponent(user)}/animelist?fields=list_status&limit=1000&nsfw=true`;
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: { "X-MAL-CLIENT-ID": clientId }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) throw new Error(`MyAnimeList user "${user}" not found or list is private`);
    if (!res.ok) throw new Error(`MyAnimeList failed (HTTP ${res.status})`);
    const d = (await res.json()) as {
      data: { node: { id: number }; list_status: { status: string; score: number; num_episodes_watched: number } }[];
      paging?: { next?: string };
    };
    for (const e of d.data)
      out.push({
        malId: e.node.id,
        status: e.list_status.status,
        score: e.list_status.score,
        episodesWatched: e.list_status.num_episodes_watched,
      });
    url = d.paging?.next ?? null;
  }
  return out;
}
