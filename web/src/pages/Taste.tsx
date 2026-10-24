import { useEffect, useState } from "react";
import { api, type Profile } from "../api";

function Bars({ items, kind }: { items: [string, { lift: number; n: number; p: number }][]; kind: "good" | "bad" }) {
  const max = Math.max(...items.map(([, s]) => (kind === "good" ? s.lift : 1 / s.lift)), 1);
  return (
    <ul className="bars">
      {items.map(([f, s]) => {
        const v = kind === "good" ? s.lift : 1 / s.lift;
        return (
          <li key={f} title={`${f.startsWith("G:") ? "Genre" : "Tag"} · seen in ${s.n} shows`}>
            <span className="name">{f.slice(2)}</span>
            <span className={`bar ${kind}`}>
              <span style={{ width: `${(v / max) * 100}%` }} />
            </span>
            <span className="val">{s.lift.toFixed(1)}×</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Taste() {
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Profile>("/profile").then(setP).catch((e) => setError(e.message));
  }, []);

  async function rebuild() {
    setBusy(true);
    setError(null);
    try {
      setP(await api<Profile>("/profile/rebuild", { body: {} }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!p) return <p className="muted">Building your taste profile… the first run reads your library and a couple of years of seasons.</p>;

  const all = Object.entries(p.features);
  const likes = all.filter(([, s]) => s.lift >= 1.3).sort((a, b) => b[1].lift - a[1].lift).slice(0, 20);
  const avoids = all.filter(([, s]) => s.lift <= 0.7).sort((a, b) => a[1].lift - b[1].lift).slice(0, 15);

  return (
    <section>
      <div className="toolbar">
        <h1>Your taste</h1>
        <button className="ghost" disabled={busy} onClick={rebuild}>
          {busy ? "Rebuilding…" : "Rebuild now"}
        </button>
      </div>
      <p className="muted">
        Learned from {p.trainedOn} shows ({p.positives} you kept or liked). "2.0×" means you keep shows with that genre or tag twice as often as average. Updated{" "}
        {new Date(p.builtAt).toLocaleString()}.
      </p>
      <div className="sources">
        {Object.entries(p.sources).map(([k, v]) => (
          <span key={k} className={`chip${v.startsWith("error") ? " bad" : ""}`}>
            {k}: {v}
          </span>
        ))}
      </div>
      {!likes.length && <p className="banner">Not enough to go on yet. Connect Sonarr/Plex in Settings or take the quiz.</p>}
      <div className="two-col">
        <div className="card pad">
          <h2>You go for</h2>
          <Bars items={likes} kind="good" />
        </div>
        <div className="card pad">
          <h2>You skip</h2>
          <Bars items={avoids} kind="bad" />
        </div>
      </div>
      {p.favourites.length > 0 && (
        <div className="card pad">
          <h2>Favourites it compares against</h2>
          <p className="muted small">{p.favourites.slice(0, 40).map((f) => f.title).join(" · ")}</p>
        </div>
      )}
    </section>
  );
}
