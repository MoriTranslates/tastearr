import { useEffect, useMemo, useState } from "react";
import { api, seasonName, shiftSeason, type Pick, type Season, type Status } from "../api";

function initialSeason(status: Status) {
  const q = new URLSearchParams(location.search);
  const season = q.get("season")?.toUpperCase() as Season | undefined;
  const year = Number(q.get("year"));
  return season && year ? { season, year } : status.season;
}

export function Picks({ status }: { status: Status }) {
  const [sel, setSel] = useState(() => initialSeason(status));
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiltered, setShowFiltered] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function load(refresh = false) {
    setPicks(null);
    setError(null);
    api<{ picks: Pick[] }>(`/picks?season=${sel.season}&year=${sel.year}${refresh ? "&refresh=1" : ""}`)
      .then((r) => setPicks(r.picks))
      .catch((e) => setError(e.message));
  }
  useEffect(load, [sel.season, sel.year]);

  const visible = useMemo(
    () => (picks ?? []).filter((p) => (showFiltered || (!p.excluded && p.verdict !== "hidden")) && (showLibrary || !p.inLibrary)),
    [picks, showFiltered, showLibrary],
  );
  const hiddenCount = (picks ?? []).length - (picks ?? []).filter((p) => !p.excluded && p.verdict !== "hidden").length;

  function patch(id: number, change: Partial<Pick>) {
    setPicks((list) => list?.map((p) => (p.id === id ? { ...p, ...change } : p)) ?? null);
  }

  async function act(p: Pick, what: "add" | "monitor") {
    setBusy(p.id);
    try {
      const r = await api<{ title: string; monitoredSeason?: number | null; season?: number }>(`/picks/${p.id}/${what}`, { body: {} });
      patch(p.id, { inLibrary: true, seasonMonitored: true, verdict: "added" });
      const s = r.monitoredSeason ?? r.season;
      setToast(`${r.title} ${what === "add" ? "added to Sonarr" : "season monitored"}${s ? ` (season ${s} only)` : ""}`);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function rate(p: Pick, verdict: string) {
    const next = p.verdict === verdict ? null : verdict;
    patch(p.id, { verdict: next });
    await api("/feedback", { body: { id: p.id, verdict: next } }).catch((e) => setToast(e.message));
  }

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <section>
      <div className="toolbar">
        <div className="season-nav">
          <button onClick={() => setSel(shiftSeason(sel, -1))} aria-label="Previous season">‹</button>
          <h1>
            {seasonName(sel.season)} {sel.year}
          </h1>
          <button onClick={() => setSel(shiftSeason(sel, 1))} aria-label="Next season">›</button>
        </div>
        <div className="toggles">
          <label>
            <input type="checkbox" checked={showLibrary} onChange={(e) => setShowLibrary(e.target.checked)} /> Show ones in my library
          </label>
          <label>
            <input type="checkbox" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} /> Show filtered ({hiddenCount})
          </label>
          <button className="ghost" onClick={() => load(true)}>
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!picks && !error && <p className="muted">Scoring this season against your taste… the first run downloads a few seasons from AniList and can take a minute.</p>}
      {picks && !visible.length && <p className="muted">Nothing announced for this season yet.</p>}

      <div className="grid">
        {visible.map((p, i) => (
          <article key={p.id} className={`pick card${p.excluded || p.verdict === "hidden" ? " dim" : ""}`} style={{ "--accent": p.color ?? "#8b5cf6" } as React.CSSProperties}>
            <a className="cover" href={p.siteUrl} target="_blank" rel="noreferrer">
              {p.cover ? <img src={p.cover} alt="" loading="lazy" /> : <div className="noimg" />}
              <span className="rank">#{i + 1}</span>
            </a>
            <div className="body">
              <h2 title={p.romaji ?? undefined}>{p.title}</h2>
              <p className="meta">
                {[p.format?.replace("_", " "), p.episodes && `${p.episodes} eps`, p.studio].filter(Boolean).join(" · ")}
              </p>
              <div className="match" title="How well this fits your taste">
                <div className="bar">
                  <div style={{ width: `${p.match}%` }} />
                </div>
                <span>{p.match}% match</span>
              </div>
              {p.similar && <p className="similar">Like {p.similar}</p>}
              <div className="chips">
                {p.reasons.map((r) => (
                  <span key={r.label} className="chip good" title={`You keep shows tagged ${r.label} ${r.lift}× as often as average`}>
                    {r.label}
                  </span>
                ))}
                {p.warnings.map((r) => (
                  <span key={r.label} className="chip bad" title={`You rarely keep ${r.label} shows (${r.lift}×)`}>
                    {r.label}
                  </span>
                ))}
              </div>
              {p.excluded && <p className="excluded">Filtered: {p.excluded}</p>}
              <div className="actions">
                {p.inLibrary ? (
                  p.seasonMonitored === false && p.tvdbSeason ? (
                    <button className="primary" disabled={busy === p.id} onClick={() => act(p, "monitor")}>
                      Monitor S{p.tvdbSeason}
                    </button>
                  ) : (
                    <span className="badge">In library</span>
                  )
                ) : p.tvdbId ? (
                  <button className="primary" disabled={busy === p.id} onClick={() => act(p, "add")}>
                    {busy === p.id ? "Adding…" : "Add to Sonarr"}
                  </button>
                ) : (
                  <span className="badge muted" title="The AniList → TVDB mapping doesn't have this show yet">No TVDB match</span>
                )}
                <button className={`icon${p.verdict === "liked" ? " on" : ""}`} title="Looks good (teaches your taste)" onClick={() => rate(p, "liked")}>
                  👍
                </button>
                <button className={`icon${p.verdict === "disliked" ? " on" : ""}`} title="Not for me (teaches your taste)" onClick={() => rate(p, "disliked")}>
                  👎
                </button>
                <button className={`icon${p.verdict === "hidden" ? " on" : ""}`} title="Hide from this list" onClick={() => rate(p, "hidden")}>
                  ✕
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}
