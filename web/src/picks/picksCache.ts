import type { Pick } from "../api";

/** Picks per season, kept while the tab is open so switching pages doesn't refetch and blank the screen. */
export const cache = new Map<string, Pick[]>();
export const clearPicksCache = () => cache.clear();
/** The top pick per season, kept while the tab is open so rating it doesn't swap the card out from under you. */
export const heroes = new Map<string, number>();
