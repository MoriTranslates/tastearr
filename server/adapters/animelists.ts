import fs from "node:fs";
import type { AnimeListRow } from "../core/mapping.js";

/** The community-maintained Fribb/anime-lists file on GitHub, kept as a local copy. */
const URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";

/** Downloads the list to `file` (via a temporary file, so a failed download never leaves half a list). */
export async function downloadAnimeList(file: string) {
  const res = await fetch(URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.writeFileSync(file + ".tmp", Buffer.from(await res.arrayBuffer()));
  fs.renameSync(file + ".tmp", file);
}

export function readAnimeList(file: string): AnimeListRow[] {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnimeListRow[];
}

/** Milliseconds since the local copy was written, or null when there is none. */
export function animeListAge(file: string): number | null {
  return fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : null;
}
