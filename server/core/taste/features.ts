import type { Media } from "./media.js";
import type { TasteConfig } from "./types.js";

/** Tags that carry a little signal but make meaningless explanations. */
export const QUIET_TAGS = new Set([
  "Male Protagonist",
  "Female Protagonist",
  "Heterosexual",
  "Shounen",
  "Seinen",
  "Shoujo",
  "Josei",
  "Primarily Adult Cast",
  "Primarily Teen Cast",
  "Primarily Male Cast",
  "Primarily Female Cast",
  "Ensemble Cast",
  "Coming of Age",
  "Episodic",
  "Primarily Child Cast",
  "Primarily Animal Cast",
  "Full CGI",
  "Chibi",
  "Kemonomimi",
  "Kuudere",
  "Tsundere",
  "Nudity",
  "Gore",
  // Real signal, but "you usually skip disability" reads badly as an explanation.
  "Disability",
  "LGBTQ+ Themes",
  "Mental Illness",
  "Suicide",
  "Bullying",
  "Slavery",
  "Assassins",
  "Curses",
]);
/** Plain names for AniList tags that read oddly on a card (the quiz uses the same words). */
const TAG_LABEL: Record<string, string> = {
  "Female Harem": "Harem",
  "Male Harem": "Reverse harem",
  "Cute Girls Doing Cute Things": "Cute & cozy",
  Iyashikei: "Relaxing",
  "Video Games": "Video-game world",
  "Urban Fantasy": "Modern-day fantasy",
  "Super Power": "Superpowers",
  Swordplay: "Sword fights",
};
export const GORE_TAGS = ["Gore", "Body Horror", "Torture", "Cannibalism"];
export const CANDIDATE_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "MOVIE"]);
export const EPISODIC_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
export const SOURCE_LABEL: Record<string, string> = {
  LIGHT_NOVEL: "Light novel",
  MANGA: "Manga",
  ORIGINAL: "Original story",
  WEB_NOVEL: "Web novel",
  VIDEO_GAME: "Video game",
  NOVEL: "Novel",
  VISUAL_NOVEL: "Visual novel",
};
/** One name per streaming service, so filters and chips don't split "Amazon Prime Video" from "Prime Video". */
const SERVICE_ALIASES: Record<string, string> = {
  "Amazon Prime Video": "Prime Video",
  Amazon: "Prime Video",
  "Amazon Video": "Prime Video",
  "Disney Plus": "Disney+",
  "Hulu Japan": "Hulu",
  HIDIVE: "HIDIVE",
  Hidive: "HIDIVE",
  Bilibili: "Bilibili TV",
  iQ: "iQIYI",
  iQiyi: "iQIYI",
};

/** A show's features: genres ("G:"), tags ranked at least `minRank` that aren't spoilers ("T:"), and source ("S:"). */
export function features(m: Media, minRank: number): string[] {
  const out = m.genres.map((g) => `G:${g}`);
  for (const t of m.tags) if (t.rank >= minRank && !t.isMediaSpoiler && !t.isGeneralSpoiler) out.push(`T:${t.name}`);
  if (m.source) out.push(`S:${m.source}`);
  return out;
}

export const label = (f: string) =>
  f.startsWith("S:")
    ? `${SOURCE_LABEL[f.slice(2)] ?? f.slice(2).replace(/_/g, " ").toLowerCase()} adaptation`
    : (TAG_LABEL[f.slice(2)] ?? f.slice(2));

export function title(m: Media, lang: TasteConfig["titleLanguage"]) {
  const t = m.title;
  return (lang === "romaji" ? t.romaji : lang === "native" ? t.native : t.english) || t.english || t.romaji || t.native || `#${m.id}`;
}

/** Counts for training: not adult, and one of the formats and countries the user trains on. */
export function eligible(m: Media, t: TasteConfig["training"]) {
  return !m.isAdult && (!m.format || t.formats.includes(m.format)) && (!m.countryOfOrigin || t.countries.includes(m.countryOfOrigin));
}

// 12-minute half-length series are real shows (and often ecchi/comedy favourites) even when AniList files them as
// TV_SHORT; only true minis are "shorts". Episode length decides when it's known, the format otherwise.
const isShortWithin = (m: Media, maxMinutes: number) =>
  m.format !== "MOVIE" && (m.duration ? m.duration <= maxMinutes : m.format === "TV_SHORT");
export const isShort = (m: Media) => isShortWithin(m, 9);

/**
 * "Skip explicit shorts". The user likes ecchi and fan service but dislikes pure porn: shows that actually show sex.
 * Those are typically shorts (6-12 min, AniList TV_SHORT) tagged Ecchi with a very high Nudity rank, and AniList doesn't
 * flag them isAdult. Full-length ecchi (24 min, Nudity 70-82) is fine and must stay. Dropping or thumbs-downing alone
 * can't fix it: the profile learns traits, and these share Ecchi/Nudity with ecchi the user likes. Training is
 * unchanged; this only keeps such shows out of picks and auto-add.
 * No extra "sex" tag signal: AniList has none on all of them (only act tags like "Public Sex" on single shows).
 */
export const EXPLICIT_SHORT_MAX_MINUTES = 15;
export const EXPLICIT_NUDITY_MIN_RANK = 75;
export const isExplicitShort = (m: Media) =>
  isShortWithin(m, EXPLICIT_SHORT_MAX_MINUTES) &&
  m.genres.includes("Ecchi") &&
  m.tags.some((t) => t.name === "Nudity" && t.rank >= EXPLICIT_NUDITY_MIN_RANK);

export function streamingLinks(m: Media) {
  const seen = new Set<string>();
  const out: { site: string; url: string }[] = [];
  for (const l of m.externalLinks ?? []) {
    // Community-edited data ends up in an <a href>: only real web links.
    if (l.type !== "STREAMING" || !/^https?:\/\//i.test(l.url ?? "")) continue;
    const site = SERVICE_ALIASES[l.site] ?? l.site;
    if (seen.has(site)) continue;
    seen.add(site);
    out.push({ site, url: l.url });
  }
  return out;
}
