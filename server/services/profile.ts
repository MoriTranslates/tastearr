import type { TasteProfile } from "../../shared/api.js";
import { inBackground } from "../adapters/anilist.js";
import { eligible } from "../core/taste/features.js";
import { seasonOf, shiftSeason, type Media, type Season } from "../core/taste/media.js";
import { acceptExtra, computeProfile, extraTrainingIds } from "../core/taste/profile.js";
import type { Ctx } from "../core/taste/types.js";
import { noteJobError, setJob } from "../data/jobs.js";
import { getValue, setValue } from "../data/kv.js";
import { getMediaByIdsResult, getSeasonResult } from "./catalog.js";
import { context, tasteEnv } from "./context.js";
import { refreshListsDetailed } from "./lists.js";
import { getSettings } from "./settings.js";

/** Builds the taste profile (a background job, one at a time) from the user context and AniList's season line-ups. */

/**
 * Builds the taste profile. `until` limits training to seasons before it (used by the offline evaluation),
 * and `save: false` keeps it out of the database.
 */
export async function buildProfile(
  opts: { until?: { season: Season; year: number }; save?: boolean; ctx?: Ctx } = {},
): Promise<TasteProfile> {
  const save = opts.save !== false;
  const progress = (detail: string) => save && setJob("profile", "running", detail);
  progress("Reading your library");
  try {
    // One settings snapshot for the whole build: a change saved meanwhile applies to the next build, never to half of
    // this one (a build takes minutes while AniList pages download).
    const s = structuredClone(getSettings());
    const env = tasteEnv();
    env.config = structuredClone(env.config);
    const problems: string[] = [];
    if (save) {
      const lists = await refreshListsDetailed(s.lists);
      for (const err of lists.errors) problems.push(`list import failed (keeping the last import): ${err}`);
    }
    const ctx = opts.ctx ?? (await context(true));
    // Sonarr, an extra Sonarr, Radarr or the media server didn't answer: a profile learned without it would replace a
    // good one with a worse one (and with no library at all, switch to quiz-only weighting). Keep the stored profile
    // and fail the job; the next build tries again.
    if (save && ctx.degraded?.length)
      throw new Error(`Kept the last taste profile because a source couldn't be read: ${ctx.degraded.join("; ")}`);
    const end = opts.until ?? seasonOf();

    // A season AniList can't send (rate limit, outage) uses its cached copy, or is left out; the build only fails
    // when no season at all could be read.
    const items = new Map<number, Media>();
    let seasonsRead = 0;
    let lastError = "";
    for (let i = 1; i <= s.training.seasons; i++) {
      const { season, year } = shiftSeason(end, -i);
      progress(`Downloading ${season.toLowerCase()} ${year} from AniList (${i}/${s.training.seasons})`);
      try {
        const { list, stale } = await getSeasonResult(season, year);
        if (stale) problems.push(stale);
        for (const m of list) if (eligible(m, env.config.training)) items.set(m.id, m);
        seasonsRead++;
      } catch (e) {
        lastError = (e as Error).message;
        problems.push(`${season.toLowerCase()} ${year} skipped: ${lastError}`);
      }
    }
    if (!seasonsRead) throw new Error(`Couldn't read any season from AniList: ${lastError}`);
    // Plus anything rated, listed, followed or watched from before the window (but nothing from after it).
    const extra = extraTrainingIds(ctx);
    progress("Fetching shows you've rated or watched");
    const got = await getMediaByIdsResult(extra.filter((id) => !items.has(id)).slice(0, 1200), true);
    if (got.failed.length) problems.push(`${got.failed.length} rated or watched shows skipped: ${got.error}`);
    for (const m of got.media) if (acceptExtra(m, opts.until)) items.set(m.id, m);

    progress("Scoring genres and tags");
    const profile = computeProfile(items, ctx, env, end);
    if (save) {
      setValue("profile", JSON.stringify(profile));
      if (problems.length) noteJobError("profile", problems.join("; "));
      const note = problems.length ? ` (${problems.length} problem${problems.length > 1 ? "s" : ""}, see the last error)` : "";
      setJob("profile", "done", `Learned from ${profile.known} shows you've seen or rated${note}`);
    }
    return profile;
  } catch (e) {
    if (save) setJob("profile", "error", (e as Error).message);
    throw e;
  }
}

export function storedProfile(): TasteProfile | null {
  const v = getValue("profile");
  return v ? JSON.parse(v) : null;
}

let building: Promise<TasteProfile> | null = null;
let lastFailure = 0;
/** After a failed build, the last good profile is used for this long before trying again (no AniList hammering). */
export const PROFILE_RETRY_MS = 30 * 60_000;

export function rebuildProfile() {
  // A build is minutes of AniList calls: background lane, so pages the user opens meanwhile aren't stuck behind it.
  building ??= inBackground(() => buildProfile())
    .catch((e: unknown) => {
      lastFailure = Date.now();
      throw e;
    })
    .finally(() => (building = null));
  return building;
}

export const isBuilding = () => building !== null;

/**
 * The stored profile, rebuilt when older than `maxAgeMs`. If the rebuild fails (AniList down) and an older profile
 * exists, that one is used, so picks and auto-add keep working; the failure stays on the profile job. `strict`
 * (the background refresh) throws instead, so the refresh doesn't report success while the profile is out of date.
 */
export async function getProfile(maxAgeMs = 86_400_000, opts: { strict?: boolean } = {}): Promise<TasteProfile> {
  const p = storedProfile();
  if (p && Date.now() - p.builtAt < maxAgeMs) return p;
  if (p && Date.now() - lastFailure < PROFILE_RETRY_MS) return p;
  try {
    return await rebuildProfile();
  } catch (e) {
    if (!p || opts.strict) throw e;
    console.warn(`Profile rebuild failed, using the one from ${new Date(p.builtAt).toISOString()}: ${(e as Error).message}`);
    return p;
  }
}
