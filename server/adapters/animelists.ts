import fs from "node:fs";
import type { AnimeListRow } from "../core/mapping.js";

/** The community-maintained Fribb/anime-lists file on GitHub, kept as a local copy. */
export const ANIME_LIST_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";

/** Parses and checks list text; throws instead of returning something that isn't a list of rows. */
export function parseAnimeList(text: string): AnimeListRow[] {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch (e) {
    throw new Error(`the anime list isn't valid JSON (${(e as Error).message})`, { cause: e });
  }
  if (!Array.isArray(rows)) throw new Error("the anime list isn't a list");
  return rows.filter((r): r is AnimeListRow => !!r && typeof r === "object");
}

/** A new copy under this share of the old one's size is refused as truncated or wrong (the list only ever grows). */
const MIN_SIZE_RATIO = 0.5;

/**
 * Downloads the list to `file`: checked, written to a temporary file, then renamed over the old copy. A failed or
 * garbled download (an HTML error page, a captive portal, a cut-off body, a much smaller file) never replaces a good
 * list.
 */
export async function downloadAnimeList(file: string) {
  const res = await fetch(ANIME_LIST_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  parseAnimeList(text);
  const oldSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (Buffer.byteLength(text) < oldSize * MIN_SIZE_RATIO)
    throw new Error(
      `the new list is much smaller than the current one (${Buffer.byteLength(text)} vs ${oldSize} bytes); keeping the current one`,
    );
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readAnimeList(file: string): AnimeListRow[] {
  return parseAnimeList(fs.readFileSync(file, "utf8"));
}

/** Milliseconds since the local copy was written, or null when there is none. */
export function animeListAge(file: string): number | null {
  return fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : null;
}
