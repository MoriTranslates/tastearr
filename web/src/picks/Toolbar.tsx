import { seasonName, shiftSeason, type Season } from "../api";
import { todayIdx } from "./helpers";

interface Props {
  sel: { season: Season; year: number };
  setSel: (s: { season: Season; year: number }) => void;
  view: "grid" | "schedule";
  setView: (v: "grid" | "schedule") => void;
  day: number | null;
  setDay: (d: number | null) => void;
  isCurrent: boolean;
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean) => void;
  filterCount: number;
}

export function Toolbar({ sel, setSel, view, setView, day, setDay, isCurrent, filtersOpen, setFiltersOpen, filterCount }: Props) {
  return (
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
  );
}
