/** MyAnimeList API v2: a user's public anime list. */

export interface MalEntry {
  malId: number;
  status: string;
  /** 0-10, 0 = unscored. */
  score: number;
  episodesWatched: number;
}

const API = "https://api.myanimelist.net";

/** Retries for network errors, 429 and 5xx (tests shrink the wait). */
export const MAL_LIMITS = { retries: 2, backoffMs: 3_000 };

type Page = {
  data?: { node?: { id?: number }; list_status?: { status?: string; score?: number; num_episodes_watched?: number } }[];
  paging?: { next?: string };
};

async function getPage(url: string, user: string, clientId: string): Promise<Page> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "X-MAL-CLIENT-ID": clientId }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt < MAL_LIMITS.retries) {
        await new Promise((r) => setTimeout(r, MAL_LIMITS.backoffMs * 2 ** attempt));
        continue;
      }
      throw new Error(`Can't reach MyAnimeList (${(e as Error).message})`, { cause: e });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAL_LIMITS.retries) {
      await new Promise((r) => setTimeout(r, MAL_LIMITS.backoffMs * 2 ** attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403)
      throw new Error(`MyAnimeList rejected the client ID (HTTP ${res.status}); check it in Settings → Lists`);
    if (res.status === 404) throw new Error(`MyAnimeList user "${user}" not found or list is private`);
    if (!res.ok) throw new Error(`MyAnimeList failed (HTTP ${res.status})`);
    let d: Page;
    try {
      d = (await res.json()) as Page;
    } catch (e) {
      throw new Error("MyAnimeList sent an answer that isn't valid JSON", { cause: e });
    }
    if (!Array.isArray(d?.data)) throw new Error("MyAnimeList sent an answer without a list");
    return d;
  }
}

/** The whole list, or an error: a page failing halfway never returns half a list (it would replace the stored one). */
export async function malUserList(user: string, clientId: string): Promise<MalEntry[]> {
  const out: MalEntry[] = [];
  let url: string | null = `${API}/v2/users/${encodeURIComponent(user)}/animelist?fields=list_status&limit=1000&nsfw=true`;
  for (let page = 0; url && page < 20; page++) {
    const d = await getPage(url, user, clientId);
    for (const e of d.data!) {
      const id = e.node?.id;
      if (!Number.isInteger(id) || !e.list_status) continue;
      out.push({
        malId: id!,
        status: e.list_status.status ?? "",
        score: e.list_status.score ?? 0,
        episodesWatched: e.list_status.num_episodes_watched ?? 0,
      });
    }
    const next = d.paging?.next ?? null;
    // The client ID only goes to MyAnimeList's own API, whatever the paging link says.
    url = next && new URL(next).origin === API ? next : null;
  }
  return out;
}
