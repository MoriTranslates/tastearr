export function relTime(ms: number) {
  const d = Math.round((Date.now() - ms) / 60_000);
  if (d < 1) return "just now";
  if (d < 60) return `${d} min ago`;
  if (d < 1440) return `${Math.round(d / 60)} h ago`;
  return `${Math.round(d / 1440)} days ago`;
}

/** Calendar-day difference in local time (today = 0, tomorrow = 1). */
export function dayDiff(ms: number) {
  const a = new Date();
  const b = new Date(ms);
  return Math.round(
    (new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) /
      86_400_000,
  );
}

export function airLabel(ms: number) {
  const d = new Date(ms);
  const diff = dayDiff(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export function dateLabel(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!m) return String(y);
  return new Date(y, m - 1, d || 1).toLocaleDateString(
    undefined,
    d ? { month: "short", day: "numeric", year: "numeric" } : { month: "long", year: "numeric" },
  );
}
