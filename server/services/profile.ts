import type { TasteProfile } from "../../shared/api.js";
import { eligible } from "../core/taste/features.js";
import { seasonOf, shiftSeason, type Media, type Season } from "../core/taste/media.js";
import { acceptExtra, computeProfile, extraTrainingIds } from "../core/taste/profile.js";
import type { Ctx } from "../core/taste/types.js";
import { setJob } from "../data/jobs.js";
import { getValue, setValue } from "../data/kv.js";
import { getMediaByIds, getSeason } from "./catalog.js";
import { context, tasteEnv } from "./context.js";
import { refreshLists } from "./lists.js";
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
    const s = getSettings();
    if (save) {
      try {
        await refreshLists();
      } catch (e) {
        console.warn("List import failed:", (e as Error).message);
      }
    }
    const ctx = opts.ctx ?? (await context(true));
    const end = opts.until ?? seasonOf();

    const items = new Map<number, Media>();
    for (let i = 1; i <= s.training.seasons; i++) {
      const { season, year } = shiftSeason(end, -i);
      progress(`Downloading ${season.toLowerCase()} ${year} from AniList (${i}/${s.training.seasons})`);
      for (const m of await getSeason(season, year)) if (eligible(m, getSettings().training)) items.set(m.id, m);
    }
    // Plus anything rated, listed, followed or watched from before the window (but nothing from after it).
    const extra = extraTrainingIds(ctx);
    progress("Fetching shows you've rated or watched");
    for (const m of await getMediaByIds(extra.filter((id) => !items.has(id)).slice(0, 1200)))
      if (acceptExtra(m, opts.until)) items.set(m.id, m);

    progress("Scoring genres and tags");
    const profile = computeProfile(items, ctx, tasteEnv(), end);
    if (save) {
      setValue("profile", JSON.stringify(profile));
      setJob("profile", "done", `Learned from ${profile.known} shows you've seen or rated`);
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

export function rebuildProfile() {
  building ??= buildProfile().finally(() => (building = null));
  return building;
}

export const isBuilding = () => building !== null;

export async function getProfile(maxAgeMs = 86_400_000): Promise<TasteProfile> {
  const p = storedProfile();
  if (p && Date.now() - p.builtAt < maxAgeMs) return p;
  return rebuildProfile();
}
