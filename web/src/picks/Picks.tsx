import { useEffect, useMemo, useState } from "react";
import { seasonName, store, type Pick, type Section, type Status } from "../api";
import { ErrorBox, Spinner, useToast } from "../components/ui";
import { usePageTitle } from "../hooks/usePageTitle";
import { AddDialog } from "./AddDialog";
import { FilterPanel } from "./FilterPanel";
import { PickCard } from "./PickCard";
import { PickSections } from "./PickSections";
import { Schedule } from "./Schedule";
import { Toolbar } from "./Toolbar";
import { isMobile } from "./helpers";
import { readPicksQuery } from "./query";
import type { Mode } from "./types";
import { usePickFilters } from "./usePickFilters";
import { usePicks, useTopPick, useVisiblePicks } from "./usePicks";

export function Picks({ status }: { status: Status }) {
  const hideShorts = status.prefs?.hideShorts ?? false;
  const init = useMemo(() => readPicksQuery(location.search, status, store.get("view", "grid")), [status]);
  const toast = useToast();
  const [sel, setSel] = useState(init.sel);
  const [view, setView] = useState(init.view);
  const filters = usePickFilters(status, init.day);
  const { day, setDay, sort, services, showLibrary, showFiltered } = filters;
  const [collapsed, setCollapsedRaw] = useState<Section[]>(
    () => store.get<Section[] | null>("collapsed", null) ?? (hideShorts ? ["shorts"] : []),
  );
  const setCollapsed = (v: Section[]) => {
    setCollapsedRaw(v);
    store.set("collapsed", v);
  };
  const [lowOpen, setLowOpen] = useState<Section[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(() => !isMobile());
  const { key, picks, error, rebuilding, patch, retry, refreshFromAniList } = usePicks(sel, !!status.building);
  const [adding, setAdding] = useState<{ p: Pick; mode: Mode } | null>(null);
  usePageTitle(`${seasonName(sel.season)} ${sel.year}`);

  useEffect(() => {
    const q = new URLSearchParams({ season: sel.season, year: String(sel.year) });
    if (view === "schedule") q.set("view", "schedule");
    if (day !== null) q.set("day", String(day));
    history.replaceState(null, "", `/?${q}`);
    store.set("view", view);
  }, [sel, view, day]);

  const allServices = useMemo(
    () => [...new Set([...services, ...(picks ?? []).flatMap((p) => p.streaming.map((x) => x.site))])].sort(),
    [picks, services],
  );
  const visible = useVisiblePicks(picks, filters);
  const hidden = (picks?.length ?? 0) - visible.length;
  const top = useTopPick(picks, services, key);
  const filterCount = (day !== null ? 1 : 0) + services.length + (showLibrary ? 0 : 1) + (showFiltered ? 1 : 0);
  const isCurrent = sel.season === status.season?.season && sel.year === status.season?.year;
  const onAdd = (p: Pick, mode: Mode = "add") => setAdding({ p, mode });

  return (
    <section>
      <Toolbar
        sel={sel}
        setSel={setSel}
        view={view}
        setView={setView}
        day={day}
        setDay={setDay}
        isCurrent={isCurrent}
        filtersOpen={filtersOpen}
        setFiltersOpen={setFiltersOpen}
        filterCount={filterCount}
      />

      {filtersOpen && (
        <FilterPanel {...filters} allServices={allServices} isCurrent={isCurrent} loaded={!!picks} onRefresh={refreshFromAniList} />
      )}

      {error && !picks && <ErrorBox error={error} retry={retry} />}
      {!picks && !error && (
        <Spinner label="Ranking this season for you… the first time can take a minute while Tastearr downloads the season from AniList." />
      )}
      {picks && !picks.length && <p className="muted">AniList hasn't announced anything for this season yet.</p>}
      {picks && picks.length > 0 && !visible.length && (
        <p className="muted">
          Your filters hide everything ({hidden}).{" "}
          <button className="ghost small" onClick={filters.clearFilters}>
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
          <PickCard p={top} patch={patch} toast={toast} status={status} onAdd={onAdd} />
        </div>
      )}
      {picks && view === "grid" && (
        <PickSections
          visible={visible}
          top={top}
          sort={sort}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          lowOpen={lowOpen}
          setLowOpen={setLowOpen}
          patch={patch}
          toast={toast}
          status={status}
          onAdd={onAdd}
        />
      )}

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
