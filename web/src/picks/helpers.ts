import type { Pick, Section } from "../api";

export const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "continuing", label: "Continuing", hint: "New seasons of shows you know, and shows still airing" },
  { id: "new", label: "New shows", hint: "Brand-new series this season" },
  { id: "shorts", label: "Shorts", hint: "Mini episodes (a few minutes each)" },
  { id: "movies", label: "Movies", hint: "Films and theatrical releases" },
];
export const SORTS = {
  match: { label: "Best match", fn: (a: Pick, b: Pick) => b.match - a.match || b.score - a.score },
  popularity: { label: "Most popular", fn: (a: Pick, b: Pick) => b.popularity - a.popularity },
  rating: { label: "Highest rated", fn: (a: Pick, b: Pick) => (b.averageScore ?? 0) - (a.averageScore ?? 0) },
  airing: { label: "Airing soonest", fn: (a: Pick, b: Pick) => (a.nextAiring?.at ?? Infinity) - (b.nextAiring?.at ?? Infinity) },
  title: { label: "A–Z", fn: (a: Pick, b: Pick) => a.title.localeCompare(b.title) },
} as const;
export type SortKey = keyof typeof SORTS;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Monday = 0, in the viewer's local time. */
export const weekday = (ms: number) => (new Date(ms).getDay() + 6) % 7;
export const todayIdx = () => weekday(Date.now());
export const isMobile = () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;

export const STATUS_BADGE: Record<string, string> = {
  watching: "You're watching",
  seen: "You've seen it",
  planning: "On your list",
  following: "Following",
  dropped: "You stopped this",
};

export function matchText(p: Pick) {
  // Before airing, a low score on a show with almost no data means "unknown", not "you'd dislike it".
  if (p.lowConfidence && p.status === "NOT_YET_RELEASED" && p.match < 35) return "Too early to tell";
  if (p.match < 15) return p.section === "shorts" ? "Mini short" : "Not for you";
  return p.lowConfidence ? `~${p.match}% match` : `${p.match}% match`;
}

export function storyLine(p: Pick) {
  if (p.continues) {
    if (p.continues.behind > 0)
      return `Sequel to ${p.continues.title}. You're ${p.continues.behind} season${p.continues.behind > 1 ? "s" : ""} behind.`;
    if (p.continues.kept) return `Continues ${p.continues.title}`;
    return p.match >= 50 ? `Sequel to ${p.continues.title}: watch the earlier seasons first` : `Sequel to ${p.continues.title}`;
  }
  if (p.compilationOf) return `Compilation of ${p.compilationOf.title}${p.compilationOf.seen ? " (you've seen it)" : ""}`;
  if (p.spinOffOf) return `Spin-off of ${p.spinOffOf}`;
  if (p.similar) return `Similar to ${p.similar}`;
  return null;
}
