import { useState } from "react";
import { api, store, type Settings as S } from "../api";
import { ListInput, NumberInput, useToast } from "../components/ui";
import { Link } from "../router";
import { errorMessage } from "../lib/errors";

/** Common legal streaming sites (AniList's names), for "my services". */
const SERVICES = [
  "Crunchyroll",
  "Netflix",
  "HIDIVE",
  "Prime Video",
  "Disney+",
  "Hulu",
  "Max",
  "Bilibili TV",
  "YouTube",
  "Muse Asia",
  "Ani-One Asia",
  "iQIYI",
  "Tubi",
  "Hoopla",
  "Laftel",
];

export function PicksSettings({ s, save }: { s: S; save: (p: Partial<S>) => Promise<S> }) {
  const toast = useToast();
  const [filters, setFilters] = useState(s.filters);
  const [training, setTraining] = useState(s.training);
  const [display, setDisplay] = useState(s.display);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({ filters, training, display });
      // New defaults should show up on Picks, so forget the filters set there earlier.
      if (JSON.stringify(display.services) !== JSON.stringify(s.display.services)) store.set("services", null);
      if (filters.hideInLibrary !== s.filters.hideInLibrary) store.set("showLibrary", null);
      if (filters.hideShorts !== s.filters.hideShorts) store.set("collapsed", null);
      if (JSON.stringify(training) !== JSON.stringify(s.training)) {
        await api("/profile/rebuild", { body: {} });
        toast("Saved. Re-learning your taste (takes a minute)…");
      } else toast("Saved");
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card pad stack">
      <h2>Picks & filters</h2>
      <div className="form">
        <label>
          Titles in
          <select
            value={display.titleLanguage}
            onChange={(e) => setDisplay({ ...display, titleLanguage: e.target.value as S["display"]["titleLanguage"] })}
          >
            <option value="english">English</option>
            <option value="romaji">Romaji</option>
            <option value="native">Native (日本語)</option>
          </select>
        </label>
        <div className="wide">
          <span>My streaming services</span>
          <div className="chips" role="group" aria-label="My streaming services">
            {[...new Set([...SERVICES, ...display.services])].map((sv) => {
              const on = display.services.includes(sv);
              return (
                <button
                  key={sv}
                  type="button"
                  className={`chip${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() =>
                    setDisplay({ ...display, services: on ? display.services.filter((x) => x !== sv) : [...display.services, sv] })
                  }
                >
                  {on ? "✓ " : ""}
                  {sv}
                </button>
              );
            })}
          </div>
          <span className="muted small">Picks and the Schedule start filtered to these. Leave empty to see everything.</span>
        </div>
        <label>
          Never show these genres
          <ListInput
            label="Excluded genres"
            value={filters.excludeGenres}
            placeholder="Slice of Life, Music"
            onChange={(v) => setFilters({ ...filters, excludeGenres: v })}
          />
        </label>
        <label>
          Never show these tags
          <ListInput
            label="Excluded tags"
            value={filters.excludeTags}
            placeholder="Kids, Idol"
            onChange={(v) => setFilters({ ...filters, excludeTags: v })}
          />
        </label>
        <label>
          Seasons to learn from
          <NumberInput
            label="Seasons"
            min={2}
            max={24}
            value={training.seasons}
            onChange={(v) => setTraining({ ...training, seasons: v })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.noGore} onChange={(e) => setFilters({ ...filters, noGore: e.target.checked })} /> Hide
          shows with gore or graphic violence
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.hideInLibrary}
            onChange={(e) => setFilters({ ...filters, hideInLibrary: e.target.checked })}
          />{" "}
          Hide shows I already have, by default
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hideShorts} onChange={(e) => setFilters({ ...filters, hideShorts: e.target.checked })} />{" "}
          Fold away the Shorts section by default
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.skipExplicitShorts}
            onChange={(e) => setFilters({ ...filters, skipExplicitShorts: e.target.checked })}
          />{" "}
          Skip explicit shorts
        </label>
        <p className="muted small">
          Never picks or auto-adds short (15 min or less) Ecchi shows with a very high Nudity tag: they show actual sex rather than fan
          service. Full-length ecchi is not affected.
        </p>
      </div>
      <p className="muted small">Filters never hide sequels of shows you watch. Your quiz genre answers live on the Quiz page.</p>
      <div className="row end">
        <Link to="/quiz" className="button ghost">
          Retake quiz
        </Link>
        <button className="primary" disabled={busy} onClick={submit}>
          Save
        </button>
      </div>
    </div>
  );
}
