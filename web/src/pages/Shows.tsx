import { useEffect, useState } from "react";
import { api, type Followed, type Show, type Status } from "../api";
import { airLabel, Spinner, usePageTitle, useToast } from "../ui";

export function Shows({ status }: { status: Status }) {
  usePageTitle("My Shows");
  const toast = useToast();
  const [data, setData] = useState<{ sonarr: Show[]; following: Followed[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    api<{ sonarr: Show[]; following: Followed[] }>("/shows").then(setData).catch((e) => setError(e.message));
  }, []);

  async function toggle(s: Show) {
    setBusy(s.tvdbId);
    try {
      const r = await api<{ dropped: boolean; monitored: boolean | null }>(`/shows/${s.tvdbId}/${s.dropped ? "undrop" : "drop"}`, { body: {} });
      setData((d) => d && { ...d, sonarr: d.sonarr.map((x) => (x.tvdbId === s.tvdbId ? { ...x, dropped: r.dropped, monitored: r.monitored } : x)) });
      toast(r.dropped ? `Dropped ${s.title}. No more alerts for it.` : `${s.title} is back on`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function unfollow(f: Followed) {
    try {
      await api(`/picks/${f.id}/unfollow`, { body: {} });
      setData((d) => d && { ...d, following: d.following.filter((x) => x.id !== f.id) });
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Spinner label="Loading your shows…" />;

  return (
    <section>
      <h1>My shows</h1>
      {status.sonarr && (
        <>
          <h2>Airing in Sonarr</h2>
          <p className="muted small">"Not into it" stops alerts, teaches your taste profile, and (if set in Settings) unmonitors the show in Sonarr.</p>
          {!data.sonarr.length && <p className="muted">No airing anime in Sonarr.</p>}
          <div className="show-list">
            {data.sonarr.map((s) => (
              <div key={s.tvdbId} className={`show-row card${s.dropped ? " dim" : ""}`}>
                {s.poster ? <img src={s.poster} alt="" loading="lazy" /> : <div className="noimg" />}
                <div className="body">
                  <h3>{s.title}</h3>
                  <p className="meta">
                    {[s.dropped ? "Dropped" : s.nextAiring && `Next: ${airLabel(Date.parse(s.nextAiring))}`, `${s.downloaded} downloaded`, s.watched !== null && `${s.watched}/${s.total} watched`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {s.watched !== null && s.total ? (
                    <div className="bar thin" role="meter" aria-label="Watched" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.watched}>
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
        </>
      )}

      <h2>Following</h2>
      <p className="muted small">Shows you follow from Picks. You get an alert when each episode airs, with where to stream it.</p>
      {!data.following.length && <p className="muted">Not following anything yet. Press Follow on a pick.</p>}
      <div className="show-list">
        {data.following.map((f) => (
          <div key={f.id} className="show-row card">
            {f.cover ? <img src={f.cover} alt="" loading="lazy" /> : <div className="noimg" />}
            <div className="body">
              <h3>
                <a href={f.siteUrl} target="_blank" rel="noreferrer">
                  {f.title}
                </a>
              </h3>
              <p className="meta">{f.nextAiring ? `Ep ${f.nextAiring.episode} · ${airLabel(f.nextAiring.at)}` : f.status === "FINISHED" ? "Finished" : "No air date yet"}</p>
              <div className="chips">
                {f.streaming.map((s) => (
                  <a key={s.site + s.url} className="chip link" href={s.url} target="_blank" rel="noreferrer">
                    ▶ {s.site}
                  </a>
                ))}
              </div>
            </div>
            <button className="ghost" onClick={() => unfollow(f)}>
              Unfollow
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
