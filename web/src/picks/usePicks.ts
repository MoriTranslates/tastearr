import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Pick, type Status } from "../api";
import { SORTS, weekday, type SortKey } from "./helpers";
import { cache, heroes } from "./picksCache";
import { errorMessage } from "../lib/errors";

/** Fetches the picks for one season (cached per season) and keeps them fresh while the taste profile rebuilds. */
export function usePicks(sel: { season: string; year: number }, building: boolean) {
  const key = `${sel.season}-${sel.year}`;
  const [picks, setPicks] = useState<Pick[] | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [refresh, setRefresh] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const cached = cache.get(key);
    setPicks(cached ?? null);
    setError(null);
    api<{ picks: Pick[] }>(`/picks?season=${sel.season}&year=${sel.year}${refresh ? "&refresh=1" : ""}`, { signal: ctrl.signal })
      .then((x) => {
        cache.set(key, x.picks);
        setPicks(x.picks);
        setRefresh(false);
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setRefresh(false);
        if (!cached) setError(errorMessage(e));
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  // The taste profile is rebuilding (e.g. the quiz was just retaken): show the old ranking, then refetch.
  const [rebuilding, setRebuilding] = useState(building);
  useEffect(() => {
    if (building) setRebuilding(true);
  }, [building]);
  useEffect(() => {
    if (!rebuilding) return;
    let alive = true;
    const poll = async () => {
      const st = await api<Status>("/status").catch(() => null);
      if (!alive) return;
      if (st && !st.building) {
        cache.clear();
        heroes.clear();
        setRebuilding(false);
        setReload((x) => x + 1);
      } else setTimeout(poll, 3000);
    };
    const t = setTimeout(poll, 3000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [rebuilding]);

  // Changes are written to the season they were made in, even if the viewer has since switched season.
  const currentKey = useRef(key);
  currentKey.current = key;
  const patch = useCallback((id: number, change: Partial<Pick>, k = currentKey.current) => {
    const next = cache.get(k)?.map((p) => (p.id === id ? { ...p, ...change } : p));
    if (next) cache.set(k, next);
    if (k === currentKey.current) setPicks((list) => list?.map((p) => (p.id === id ? { ...p, ...change } : p)) ?? null);
  }, []);

  const retry = () => setReload((x) => x + 1);
  const refreshFromAniList = () => {
    setRefresh(true);
    setReload((x) => x + 1);
  };
  return { key, picks, error, rebuilding, patch, retry, refreshFromAniList };
}

export interface PickFilter {
  showFiltered: boolean;
  showLibrary: boolean;
  services: string[];
  day: number | null;
  sort: SortKey;
}

/** The picks that pass the viewer's filters, in the chosen order. */
export function useVisiblePicks(picks: Pick[] | null, { showFiltered, showLibrary, services, day, sort }: PickFilter) {
  return useMemo(() => {
    const list = (picks ?? []).filter(
      (p) =>
        (showFiltered || !p.excluded) &&
        (showLibrary || !p.inLibrary) &&
        (!services.length ||
          p.streaming.some((x) => services.includes(x.site)) ||
          (!p.streaming.length && (p.status === "NOT_YET_RELEASED" || p.format === "MOVIE"))) &&
        (day === null || (p.nextAiring && weekday(p.nextAiring.at) === day)),
    );
    return list.sort(SORTS[sort].fn);
  }, [picks, showFiltered, showLibrary, services, day, sort]);
}

/** Something new to start: streamable or addable, not a movie or mini, and never a sequel to something not seen. */
export function useTopPick(picks: Pick[] | null, services: string[], key: string) {
  return useMemo(() => {
    const ok = (p: Pick) =>
      !p.excluded &&
      !p.inLibrary &&
      !p.myStatus &&
      !p.following &&
      p.match >= 60 &&
      (p.section === "new" || p.section === "continuing") &&
      (p.streaming.length > 0 || p.addVia || p.needsMatch) &&
      (!p.continues || p.continues.kept) &&
      (!services.length || p.streaming.some((x) => services.includes(x.site)));
    const kept = picks?.find((p) => p.id === heroes.get(key));
    if (kept && ok(kept)) return kept;
    // Rather than no top pick at all: a strong sequel to something not seen yet, labelled "start with season 1".
    const unseenSequel = (p: Pick) => ok({ ...p, continues: null }) && p.match >= 75 && !!p.continues && !p.continues.kept;
    const pool = (picks ?? []).filter((p) => !p.verdict);
    const best =
      pool.filter(ok).sort((a, b) => b.match - a.match)[0] ?? pool.filter(unseenSequel).sort((a, b) => b.match - a.match)[0] ?? null;
    if (best) heroes.set(key, best.id);
    return best;
  }, [picks, services, key]);
}
