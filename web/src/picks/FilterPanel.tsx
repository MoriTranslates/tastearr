import { DAYS, SORTS, todayIdx, type SortKey } from "./helpers";
import type { PickFilter } from "./usePicks";

interface Props extends PickFilter {
  setSort: (s: SortKey) => void;
  setDay: (d: number | null) => void;
  setServices: (v: string[]) => void;
  setShowLibrary: (v: boolean) => void;
  setShowFiltered: (v: boolean) => void;
  allServices: string[];
  isCurrent: boolean;
  loaded: boolean;
  onRefresh: () => void;
}

export function FilterPanel({
  sort,
  setSort,
  day,
  setDay,
  services,
  setServices,
  showLibrary,
  setShowLibrary,
  showFiltered,
  setShowFiltered,
  allServices,
  isCurrent,
  loaded,
  onRefresh,
}: Props) {
  return (
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
          <button key={d} className={`chip${day === i ? " on" : ""}`} aria-pressed={day === i} onClick={() => setDay(day === i ? null : i)}>
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
      <button className="ghost small" disabled={!loaded} onClick={onRefresh}>
        Refresh from AniList
      </button>
    </div>
  );
}
