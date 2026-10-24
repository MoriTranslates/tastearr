import { useEffect, useState } from "react";
import { api, type Show } from "../api";

function when(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return days <= 0 ? `Today · ${label}` : days === 1 ? `Tomorrow · ${label}` : label;
}

export function Shows() {
  const [shows, setShows] = useState<Show[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    api<Show[]>("/shows").then(setShows).catch((e) => setError(e.message));
  }, []);

  async function toggle(s: Show) {
    setBusy(s.tvdbId);
    try {
      await api(`/shows/${s.tvdbId}/${s.dropped ? "undrop" : "drop"}`, { body: {} });
      setShows((list) => list?.map((x) => (x.tvdbId === s.tvdbId ? { ...x, dropped: !s.dropped, monitored: s.dropped } : x)) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!shows) return <p className="muted">Loading your airing shows…</p>;

  return (
    <section>
      <h1>My shows</h1>
      <p className="muted">Anime still airing in Sonarr. "Not into it" stops alerts, teaches your taste profile, and (if set in Settings) unmonitors it in Sonarr.</p>
      {!shows.length && <p className="muted">No airing anime in Sonarr yet.</p>}
      <div className="show-list">
        {shows.map((s) => (
          <div key={s.tvdbId} className={`show-row card${s.dropped ? " dim" : ""}`}>
            {s.poster ? <img src={s.poster} alt="" loading="lazy" /> : <div className="noimg" />}
            <div className="body">
              <h3>{s.title}</h3>
              <p className="meta">
                {[
                  s.dropped ? "Dropped" : when(s.nextAiring) && `Next: ${when(s.nextAiring)}`,
                  `${s.downloaded} downloaded`,
                  s.watched !== null && `${s.watched}/${s.total} watched`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {s.watched !== null && s.total ? (
                <div className="bar thin">
                  <div style={{ width: `${Math.min(100, (s.watched / s.total) * 100)}%` }} />
                </div>
              ) : null}
            </div>
            <button className={s.dropped ? "ghost" : "danger"} disabled={busy === s.tvdbId} onClick={() => toggle(s)}>
              {s.dropped ? "Back on" : "Not into it"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
