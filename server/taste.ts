import { db, droppedSet } from "./db.js";
import { getMediaByIds, getSeason, seasonOf, shiftSeason, type Media, type Season } from "./anilist.js";
import { mappingTables } from "./mapping.js";
import { watchStates, type WatchState } from "./mediaserver.js";
import { getSettings } from "./settings.js";
import { sonarrSeries } from "./sonarr.js";

/**
 * Taste model: for every genre/tag, how much more often than average the user keeps shows that have it.
 * Training data is the last N seasons as aired on AniList, labelled by what's in Sonarr, how far the user
 * got in Plex/Jellyfin, and explicit quiz/thumbs feedback.
 */

export interface FeatureStat { lift: number; n: number; p: number }
export interface Profile {
  builtAt: number;
  trainedOn: number;
  positives: number;
  base: number;
  features: Record<string, FeatureStat>;
  /** Shows the user clearly enjoyed, for "similar to X" explanations. */
  favourites: { id: number; title: string; feats: string[] }[];
  sources: Record<string, string>;
}

const SMOOTH = 4;
const MIN_SUPPORT = 4;

export function features(m: Media, minRank = getSettings().training.minTagRank): string[] {
  return [...m.genres.map((g) => `G:${g}`), ...m.tags.filter((t) => t.rank >= minRank).map((t) => `T:${t.name}`)];
}

export const label = (f: string) => f.slice(2);

export function title(m: Media) {
  return m.title.english || m.title.romaji || `#${m.id}`;
}

function eligible(m: Media) {
  const t = getSettings().training;
  return !m.isAdult && (!m.format || t.formats.includes(m.format)) && (!m.countryOfOrigin || t.countries.includes(m.countryOfOrigin));
}

interface Labelled { m: Media; n: number; p: number; fav: boolean }

function labelFor(m: Media, tvdb: number | undefined, lib: Set<number>, watch: Map<number, WatchState>, verdict: string | undefined, dropped: Set<number>): Labelled {
  let n = 1;
  let p = 0;
  let fav = false;
  if (tvdb && dropped.has(tvdb)) return { m, n: 1.5, p: 0.2, fav: false }; // "not into it anymore"
  if (tvdb && lib.has(tvdb)) p = 1;
  const w = tvdb ? watch.get(tvdb) : undefined;
  if (w && w.total > 0) {
    const frac = w.watched / w.total;
    if (w.watched >= 3 || frac >= 0.5) {
      p = Math.max(p, 1.5 + frac);
      fav = frac >= 0.5;
    } else if (w.watched >= 1 && w.total >= 6 && frac < 0.25) {
      p = Math.min(p, 0.3); // tried it, dropped it
    }
  }
  switch (verdict) {
    case "loved": p = 3; fav = true; break;
    case "liked": p = 2; fav = true; break;
    case "added": p = Math.max(p, 1.5); break;
    case "meh": p = 0.3; fav = false; break;
    case "hidden": p = Math.min(p, 0.2); fav = false; break;
    case "disliked": p = 0; n = 2; fav = false; break;
  }
  return { m, n, p, fav };
}

export async function buildProfile(): Promise<Profile> {
  const s = getSettings();
  const sources: Record<string, string> = {};
  const { byAnilist, byTvdb } = await mappingTables();

  let lib = new Set<number>();
  if (s.sonarr.url && s.sonarr.apiKey) {
    try {
      lib = new Set((await sonarrSeries(true)).map((x) => x.tvdbId));
      sources.sonarr = `${lib.size} series`;
    } catch (e) {
      sources.sonarr = `error: ${(e as Error).message}`;
    }
  } else sources.sonarr = "not connected";

  let watch = new Map<number, WatchState>();
  if (s.media.type !== "none") {
    try {
      watch = await watchStates();
      sources.media = `${[...watch.values()].filter((w) => w.watched > 0).length} shows with watch history`;
    } catch (e) {
      sources.media = `error: ${(e as Error).message}`;
    }
  } else sources.media = "not connected";

  const fb = new Map((db.prepare("SELECT anilist_id, verdict, source FROM feedback").all() as { anilist_id: number; verdict: string; source: string }[]).map((r) => [r.anilist_id, r]));
  sources.feedback = `${[...fb.values()].filter((r) => r.source === "quiz").length} quiz answers, ${[...fb.values()].filter((r) => r.source !== "quiz").length} ratings`;

  // Training window: the last N complete seasons.
  const now = seasonOf();
  const items = new Map<number, Media>();
  for (let i = 1; i <= s.training.seasons; i++) {
    const { season, year } = shiftSeason(now, -i);
    for (const m of await getSeason(season, year)) if (eligible(m)) items.set(m.id, m);
  }
  // Plus anything the user rated, and well-watched shows from before the window.
  const extra = new Set<number>([...fb.keys()]);
  for (const [tvdb, w] of watch) if (w.watched >= 3) for (const id of byTvdb.get(tvdb) ?? []) extra.add(id);
  for (const m of await getMediaByIds([...extra].filter((id) => !items.has(id)).slice(0, 600))) if (!m.isAdult) items.set(m.id, m);

  const dropped = droppedSet();
  sources.dropped = `${dropped.size} dropped shows`;
  const rows = [...items.values()].map((m) => labelFor(m, byAnilist.get(m.id)?.tvdbId, lib, watch, fb.get(m.id)?.verdict, dropped));
  const sumN = rows.reduce((a, r) => a + r.n, 0);
  const sumP = rows.reduce((a, r) => a + r.p, 0);
  const base = sumN ? sumP / sumN : 0;

  const acc = new Map<string, { n: number; p: number }>();
  for (const r of rows) for (const f of new Set(features(r.m))) {
    const a = acc.get(f) ?? { n: 0, p: 0 };
    a.n += r.n;
    a.p += r.p;
    acc.set(f, a);
  }
  const feats: Record<string, FeatureStat> = {};
  if (base > 0) {
    for (const [f, a] of acc) if (a.n >= MIN_SUPPORT) feats[f] = { lift: (a.p + base * SMOOTH) / (a.n + SMOOTH) / base, n: Math.round(a.n), p: Math.round(a.p * 10) / 10 };
  }
  // Quiz genre answers act as a strong prior on top of the learned value.
  for (const [g, pref] of Object.entries(s.genrePrefs)) {
    const k = `G:${g}`;
    const cur = feats[k] ?? { lift: 1, n: 0, p: 0 };
    if (pref === "love") feats[k] = { ...cur, lift: Math.max(cur.lift * 1.5, 1.8) };
    if (pref === "never") feats[k] = { ...cur, lift: Math.min(cur.lift, 0.2) };
  }

  const profile: Profile = {
    builtAt: Date.now(),
    trainedOn: rows.length,
    positives: rows.filter((r) => r.p >= 1).length,
    base,
    features: feats,
    favourites: rows.filter((r) => r.fav && eligible(r.m) && r.m.format !== "TV_SHORT").sort((a, b) => b.p - a.p).slice(0, 300).map((r) => ({ id: r.m.id, title: title(r.m), feats: features(r.m) })),
    sources,
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(profile));
  return profile;
}

export function storedProfile(): Profile | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'profile'").get() as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
}

let building: Promise<Profile> | null = null;

export async function getProfile(maxAgeMs = 86_400_000): Promise<Profile> {
  const p = storedProfile();
  if (p && Date.now() - p.builtAt < maxAgeMs) return p;
  building ??= buildProfile().finally(() => (building = null));
  return building;
}

export interface Pick {
  id: number;
  title: string;
  romaji: string | null;
  format: string | null;
  episodes: number | null;
  studio: string | null;
  cover: string | null;
  color: string | null;
  siteUrl: string;
  description: string | null;
  genres: string[];
  popularity: number;
  averageScore: number | null;
  score: number;
  match: number;
  taste: number;
  reasons: { label: string; lift: number }[];
  warnings: { label: string; lift: number }[];
  similar: string | null;
  excluded: string | null;
  tvdbId: number | null;
  tvdbSeason: number | null;
  inLibrary: boolean;
  seasonMonitored: boolean | null;
  verdict: string | null;
}

function jaccard(a: Set<string>, b: string[]) {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  return inter / (a.size + b.length - inter || 1);
}

export async function recommend(season: Season, year: number, refresh = false): Promise<{ picks: Pick[]; profileBuiltAt: number }> {
  const s = getSettings();
  const [list, profile, { byAnilist }] = await Promise.all([getSeason(season, year, refresh), getProfile(), mappingTables()]);
  let series: Awaited<ReturnType<typeof sonarrSeries>> = [];
  if (s.sonarr.url && s.sonarr.apiKey) series = await sonarrSeries(refresh).catch(() => []);
  const byTvdb = new Map(series.map((x) => [x.tvdbId, x]));
  const fb = new Map((db.prepare("SELECT anilist_id, verdict FROM feedback").all() as { anilist_id: number; verdict: string }[]).map((r) => [r.anilist_id, r.verdict]));
  const neverGenres = new Set([...s.filters.excludeGenres, ...Object.entries(s.genrePrefs).filter(([, v]) => v === "never").map(([g]) => g)]);
  const excludeTags = new Set(s.filters.excludeTags);

  const picks: Pick[] = list.filter(eligible).map((m) => {
    const feats = features(m);
    const known = feats.filter((f) => profile.features[f]);
    const logs = known.map((f) => Math.log(profile.features[f].lift)).sort((a, b) => b - a);
    const raw = logs.length ? (logs.reduce((a, b) => a + b, 0) / logs.length) * 3 + logs.slice(0, 4).reduce((a, b) => a + b, 0) / Math.min(4, logs.length) : 0;
    // Shows with only a few known genres/tags get pulled toward neutral: there isn't enough to judge them on.
    const taste = raw * (logs.length / (logs.length + 4));
    const score = taste + 0.35 * Math.log10(Math.max(m.popularity, 10));
    const byLift = known.map((f) => ({ label: label(f), lift: Math.round(profile.features[f].lift * 10) / 10 }));

    const mine = new Set(feats);
    let similar: string | null = null;
    let best = 0.35;
    for (const f of profile.favourites) {
      if (f.id === m.id) continue;
      const j = jaccard(mine, f.feats);
      if (j > best) [best, similar] = [j, f.title];
    }

    const badGenre = m.genres.find((g) => neverGenres.has(g));
    const badTag = m.tags.find((t) => t.rank >= s.training.minTagRank && excludeTags.has(t.name));
    const map = byAnilist.get(m.id);
    const inLib = map ? byTvdb.get(map.tvdbId) : undefined;
    return {
      id: m.id,
      title: title(m),
      romaji: m.title.romaji,
      format: m.format,
      episodes: m.episodes,
      studio: m.studios.nodes[0]?.name ?? null,
      cover: m.coverImage.large,
      color: m.coverImage.color,
      siteUrl: m.siteUrl,
      description: m.description?.replace(/<[^>]+>/g, "").slice(0, 600) ?? null,
      genres: m.genres,
      popularity: m.popularity,
      averageScore: m.averageScore,
      score,
      match: Math.round(100 / (1 + Math.exp(-2.2 * (taste - 0.9)))),
      taste: Math.round(taste * 100) / 100,
      reasons: byLift.filter((x) => x.lift >= 1.3).sort((a, b) => b.lift - a.lift).slice(0, 3),
      warnings: byLift.filter((x) => x.lift <= 0.6).sort((a, b) => a.lift - b.lift).slice(0, 2),
      similar,
      excluded: badGenre ? `Genre: ${badGenre}` : badTag ? `Tag: ${badTag.name}` : null,
      tvdbId: map?.tvdbId ?? null,
      tvdbSeason: map?.season ?? null,
      inLibrary: !!inLib,
      seasonMonitored: inLib && map?.season ? (inLib.seasons.find((x) => x.seasonNumber === map.season)?.monitored ?? null) : null,
      verdict: fb.get(m.id) ?? null,
    };
  });
  picks.sort((a, b) => b.score - a.score);
  return { picks, profileBuiltAt: profile.builtAt };
}

export function setFeedback(id: number, verdict: string | null, source = "picks") {
  if (!verdict) db.prepare("DELETE FROM feedback WHERE anilist_id = ?").run(id);
  else
    db.prepare("INSERT INTO feedback (anilist_id, verdict, source, at) VALUES (?, ?, ?, ?) ON CONFLICT(anilist_id) DO UPDATE SET verdict = excluded.verdict, source = excluded.source, at = excluded.at").run(
      id,
      verdict,
      source,
      Date.now(),
    );
}
