import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, seasonName, shiftSeason, store, type Pick, type Season, type Section, type Status } from "../api";
import { ErrorBox, Spinner, useToast } from "../components/ui";
import { usePageTitle } from "../hooks/usePageTitle";
import { AddDialog } from "./AddDialog";
import { PickCard } from "./PickCard";
import { Schedule } from "./Schedule";
import { DAYS, SECTIONS, SORTS, isMobile, todayIdx, weekday, type SortKey } from "./helpers";
import { cache, heroes } from "./picksCache";

function readQuery(status: Status) {
  const q = new URLSearchParams(location.search);
  const season = q.get("season")?.toUpperCase() as Season | undefined;
  const year = Number(q.get("year"));
  return {
    sel: season && year ? { season, year } : status.season!,
    view: ((q.get("view") ?? store.get("view", "grid")) === "schedule" ? "schedule" : "grid") as "grid" | "schedule",
    day: q.get("day") !== null && q.get("day") !== "" ? Number(q.get("day")) : null,
  };
}

export function Picks({ status }: { status: Status }) {
  const hideInLibrary = status.prefs?.hideInLibrary ?? false;
  const hideShorts = status.prefs?.hideShorts ?? false;
  const init = useMemo(() => readQuery(status), [status]);
  const toast = useToast();
  const [sel, setSel] = useState(init.sel);
  const [view, setView] = useState(init.view);
  const [day, setDay] = useState<number | null>(init.day);
  const [sort, setSort] = useState<SortKey>(() => store.get("sort", "match"));
  // Settings defaults (my services, hide in library, hide shorts) apply until the viewer changes the toggle here.
  const [services, setServicesRaw] = useState<string[]>(() => store.get<string[] | null>("services", null) ?? status.prefs?.services ?? []);
  const [showLibrary, setShowLibraryRaw] = useState(() => store.get<boolean | null>("showLibrary", null) ?? !hideInLibrary);
  const [showFiltered, setShowFiltered] = useState(false);
  const [collapsed, setCollapsedRaw] = useState<Section[]>(
    () => store.get<Section[] | null>("collapsed", null) ?? (hideShorts ? ["shorts"] : []),
  );
  const setServices = (v: string[]) => (setServicesRaw(v), store.set("services", v));
  const setShowLibrary = (v: boolean) => (setShowLibraryRaw(v), store.set("showLibrary", v));
  const setCollapsed = (v: Section[]) => (setCollapsedRaw(v), store.set("collapsed", v));
  const [lowOpen, setLowOpen] = useState<Section[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(() => !isMobile());
  const key = `${sel.season}-${sel.year}`;
  const [picks, setPicks] = useState<Pick[] | null>(() => cache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [refresh, setRefresh] = useState(false);
  const [adding, setAdding] = useState<{ p: Pick; mode: "add" | "monitor" | "pick-season" } | null>(null);
  usePageTitle(`${seasonName(sel.season)} ${sel.year}`);

  useEffect(() => {
    const q = new URLSearchParams({ season: sel.season, year: String(sel.year) });
    if (view === "schedule") q.set("view", "schedule");
    if (day !== null) q.set("day", String(day));
    history.replaceState(null, "", `/?${q}`);
    store.set("view", view);
  }, [sel, view, day]);
  useEffect(() => store.set("sort", sort), [sort]);

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
        if (!cached) setError((e as Error).message);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reload]);

  // The taste profile is rebuilding (e.g. the quiz was just retaken): show the old ranking, then refetch.
  const [rebuilding, setRebuilding] = useState(!!status.building);
  useEffect(() => {
    if (status.building) setRebuilding(true);
  }, [status.building]);
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

  const allServices = useMemo(
    () => [...new Set([...services, ...(picks ?? []).flatMap((p) => p.streaming.map((x) => x.site))])].sort(),
    [picks, services],
  );
  const visible = useMemo(() => {
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
  const hidden = (picks?.length ?? 0) - visible.length;
  // Something new to start: streamable or addable, not a movie or mini, and never a sequel to something not seen.
  const top = useMemo(() => {
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
  const filterCount = (day !== null ? 1 : 0) + services.length + (showLibrary ? 0 : 1) + (showFiltered ? 1 : 0);
  const isCurrent = sel.season === status.season?.season && sel.year === status.season?.year;

  return (
    <section>
      <div className="toolbar">
        <div className="season-nav">
          <button onClick={() => setSel(shiftSeason(sel, -1))} aria-label="Previous season" title="Previous season">
            ‹
          </button>
          <h1>
            {seasonName(sel.season)} {sel.year}
          </h1>
          <button onClick={() => setSel(shiftSeason(sel, 1))} aria-label="Next season" title="Next season">
            ›
          </button>
        </div>
        <div className="row">
          {isCurrent && (
            <button
              className={view === "schedule" && day === todayIdx() ? "primary" : ""}
              onClick={() => {
                setView("schedule");
                setDay(todayIdx());
              }}
            >
              Today
            </button>
          )}
          <div className="seg" role="group" aria-label="View">
            {(["grid", "schedule"] as const).map((v) => (
              <button key={v} aria-pressed={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                <span aria-hidden="true">{v === "grid" ? "★" : "🗓"}</span>{" "}
                <span className="view-label">{v === "grid" ? "Picks" : "Schedule"}</span>
              </button>
            ))}
          </div>
          <button className="ghost" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
            Filters{filterCount ? ` (${filterCount})` : ""}
          </button>
        </div>
      </div>

      {filtersOpen && (
        <div className="filters card pad">
          <label className="inline">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {Object.entries(SORTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <div className="chips scroll" role="group" aria-label="Air day">
            {DAYS.map((d, i) => (
              <button
                key={d}
                className={`chip${day === i ? " on" : ""}`}
                aria-pressed={day === i}
                onClick={() => setDay(day === i ? null : i)}
              >
                {i === todayIdx() && isCurrent ? "Today" : d}
              </button>
            ))}
          </div>
          {allServices.length > 0 && (
            <div className="chips scroll" role="group" aria-label="Where it streams">
              {allServices.map((sv) => {
                const on = services.includes(sv);
                return (
                  <button
                    key={sv}
                    className={`chip${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => setServices(on ? services.filter((x) => x !== sv) : [...services, sv])}
                  >
                    {on ? "✓ " : ""}
                    {sv}
                  </button>
                );
              })}
            </div>
          )}
          <label className="check small">
            <input type="checkbox" checked={showLibrary} onChange={(e) => setShowLibrary(e.target.checked)} /> Show ones I already have
          </label>
          <label className="check small">
            <input type="checkbox" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} /> Show hidden ones
          </label>
          <button
            className="ghost small"
            disabled={!picks}
            onClick={() => {
              setRefresh(true);
              setReload((x) => x + 1);
            }}
          >
            Refresh from AniList
          </button>
        </div>
      )}

      {error && !picks && <ErrorBox error={error} retry={() => setReload((x) => x + 1)} />}
      {!picks && !error && (
        <Spinner label="Ranking this season for you… the first time can take a minute while Tastearr downloads the season from AniList." />
      )}
      {picks && !picks.length && <p className="muted">AniList hasn't announced anything for this season yet.</p>}
      {picks && picks.length > 0 && !visible.length && (
        <p className="muted">
          Your filters hide everything ({hidden}).{" "}
          <button
            className="ghost small"
            onClick={() => {
              setDay(null);
              setServicesRaw([]);
              store.set("services", null); // back to "my services" from Settings next time
              setShowFiltered(true);
              setShowLibrary(true);
            }}
          >
            Clear filters
          </button>
        </p>
      )}

      {rebuilding && <p className="banner">Updating your picks with your new answers…</p>}

      {picks && view === "grid" && !top && day === null && picks.length > 0 && (
        <p className="muted small">Nothing new this season is a strong match for you yet. Sequels and shows you follow are below.</p>
      )}
      {picks && view === "grid" && top && day === null && (
        <div className="hero">
          <h2 className="small muted">
            Top pick for you · {top.match}% match{top.continues && !top.continues.kept ? ` · start with ${top.continues.title} first` : ""}
          </h2>
          <PickCard p={top} patch={patch} toast={toast} status={status} onAdd={(p, mode = "add") => setAdding({ p, mode })} />
        </div>
      )}

      {picks &&
        view === "grid" &&
        SECTIONS.map((sec) => {
          const all = visible.filter((p) => p.section === sec.id && p.id !== top?.id);
          if (!all.length) return null;
          const open = !collapsed.includes(sec.id);
          // Low matches (mostly kids minis and promos in Shorts) wait behind "show more" unless sorted otherwise.
          const cut = sec.id === "shorts" ? 20 : 15;
          const early = (p: Pick) => p.lowConfidence && p.status === "NOT_YET_RELEASED";
          const low =
            sort === "match" && !lowOpen.includes(sec.id)
              ? all.filter((p) => p.match < cut && !early(p) && !p.inLibrary && !p.myStatus && !p.following)
              : [];
          const items = all.filter((p) => !low.includes(p));
          if (sec.id === "continuing" && sort === "match")
            items.sort(
              (a, b) =>
                Number(!!b.continues?.kept || !!b.myStatus || b.inLibrary) - Number(!!a.continues?.kept || !!a.myStatus || a.inLibrary),
            );
          return (
            <div key={sec.id} className="section">
              <h2 className="section-head">
                <button
                  aria-expanded={open}
                  onClick={() => setCollapsed(open ? [...collapsed, sec.id] : collapsed.filter((x) => x !== sec.id))}
                >
                  <span className="caret" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                  {sec.label}
                  <span className="count">{items.length}</span>
                </button>
                <span className="muted small hint">{sec.hint}</span>
              </h2>
              {open && (
                <>
                  <div className="grid">
                    {items.map((p) => (
                      <PickCard
                        key={p.id}
                        p={p}
                        patch={patch}
                        toast={toast}
                        status={status}
                        onAdd={(p, mode = "add") => setAdding({ p, mode })}
                      />
                    ))}
                  </div>
                  {low.length > 0 && (
                    <button className="ghost small more-low" onClick={() => setLowOpen([...lowOpen, sec.id])}>
                      Show {low.length} more that don't look like your thing
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

      {picks && view === "schedule" && (
        <Schedule
          picks={visible}
          all={picks}
          day={day}
          patch={patch}
          toast={toast}
          status={status}
          onAdd={(p, mode = "add") => setAdding({ p, mode })}
          isCurrent={isCurrent}
        />
      )}
      {adding && <AddDialog p={adding.p} mode={adding.mode} onClose={() => setAdding(null)} patch={patch} toast={toast} />}
    </section>
  );
}
