import type { ScoredPick } from "../../shared/api.js";
import { carryOverIds, isCandidate, isCarryOver, relatedIds } from "../core/taste/candidates.js";
import type { Media, Season } from "../core/taste/media.js";
import { scoreCandidates } from "../core/taste/score.js";
import { prequelIds } from "../core/taste/sequels.js";
import { setVerdict } from "../data/feedback.js";
import { cachedMedia, getMediaByIdsResult, getSeason } from "./catalog.js";
import { context, refreshCachedFeedback, tasteEnv } from "./context.js";
import { dropInferred, setInferred } from "./mapping.js";
import { getProfile } from "./profile.js";

/** A season's recommendations: candidates, their franchise context fetched, scored against the profile. */

export async function recommend(season: Season, year: number, refresh = false): Promise<{ picks: ScoredPick[]; profileBuiltAt: number }> {
  // One settings snapshot for the whole pass, so a change saved while AniList pages load can't mix two configs.
  const env = tasteEnv();
  env.config = structuredClone(env.config);
  const cfg = env.config;
  const [list, profile, ctx] = await Promise.all([getSeason(season, year, refresh), getProfile(), context(refresh)]);

  // Carry-overs: anything the user follows that started earlier and is still airing into this season.
  const ids = new Set(list.map((m) => m.id));
  const followed = carryOverIds(ctx, season, year);
  // Partial fetches: a failed AniList batch only costs the shows in it (logged), not the whole season's picks.
  const carryCandidates = (await mediaOrLog(followed.filter((id) => !ids.has(id)).slice(0, 400))).filter((m) =>
    isCarryOver(m, season, year, cfg),
  );
  const carryIds = new Set(carryCandidates.map((m) => m.id));
  // AniList pages can repeat a show when popularity shifts mid-pagination.
  const candidates = [...new Map([...list.filter((m) => isCandidate(m, cfg)), ...carryCandidates].map((m) => [m.id, m])).values()];

  // Prefetch the prequel chain and parents so sequels can inherit labels, titles and tags, and the source manga of
  // tag-sparse shows (one batched request).
  let frontier = relatedIds(candidates, cfg);
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const got = await mediaOrLog(frontier);
    frontier = [...new Set(got.flatMap(prequelIds))].filter((id) => !cachedMedia(id));
  }

  const picks = scoreCandidates(candidates, profile, ctx, env, { carryIds });
  rememberGuesses(picks);
  picks.sort((a, b) => b.match - a.match || b.score - a.score);
  return { picks, profileBuiltAt: profile.builtAt };
}

async function mediaOrLog(ids: number[]): Promise<Media[]> {
  const r = await getMediaByIdsResult(ids, true);
  if (r.failed.length) console.warn(`Picks: ${r.failed.length} related shows skipped: ${r.error}`);
  return r.media;
}

/**
 * Remembers TVDB matches guessed from an earlier season (so Add and Monitor can use them) and forgets guesses that no
 * longer hold. A pick's match was guessed exactly when `matchGuessed` is set; it has none when `tvdbId` is null.
 */
function rememberGuesses(picks: ScoredPick[]) {
  for (const p of picks) {
    if (p.matchGuessed) setInferred(p.id, { tvdbId: p.tvdbId!, season: p.tvdbSeason });
    else if (p.tvdbId === null) dropInferred(p.id);
  }
}

/** Records a verdict (null clears it) and keeps the cached context in step. */
export function setFeedback(id: number, verdict: string | null, source = "picks") {
  setVerdict(id, verdict, source);
  refreshCachedFeedback();
}
