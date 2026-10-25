import { useEffect, useState } from "react";
import { api, type Job, type Profile } from "../api";
import { Link } from "../App";
import { relTime, Spinner, usePageTitle, useToast } from "../ui";

const name = (f: string) => (f.startsWith("S:") ? `${f.slice(2).replace(/_/g, " ").toLowerCase()} (source)` : f.slice(2));

function Bars({ items, kind }: { items: [string, { lift: number; n: number }][]; kind: "good" | "bad" }) {
  const max = Math.max(...items.map(([, s]) => (kind === "good" ? s.lift : 1 / s.lift)), 1);
  return (
    <ul className="bars">
      {items.map(([f, s]) => {
        const v = kind === "good" ? s.lift : 1 / s.lift;
        return (
          <li key={f}>
            <span className="name" title={`${f.startsWith("G:") ? "Genre" : f.startsWith("S:") ? "Source" : "Tag"} · seen in about ${Math.round(s.n)} shows`}>
              {name(f)}
            </span>
            <span className={`bar ${kind}`} aria-hidden="true">
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
  usePageTitle("Your taste");
  const toast = useToast();
  const [p, setP] = useState<Profile | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [prof, sys] = await Promise.all([api<Profile>("/profile"), api<{ jobs: Job[] }>("/system")]);
        if (!alive) return;
        const j = sys.jobs.find((x) => x.name === "profile") ?? null;
        setJob(j);
        if (!prof.building) setP(prof);
        if (prof.building || j?.state === "running") timer = setTimeout(load, 2000);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  async function rebuild() {
    try {
      await api("/profile/rebuild", { body: {} });
      toast("Rebuilding… this page updates when it's done");
      setJob({ name: "profile", state: "running", detail: "Starting", startedAt: Date.now(), finishedAt: null });
      const poll = async () => {
        const sys = await api<{ jobs: Job[] }>("/system");
        const j = sys.jobs.find((x) => x.name === "profile") ?? null;
        setJob(j);
        if (j?.state === "running") setTimeout(poll, 2000);
        else setP(await api<Profile>("/profile"));
      };
      setTimeout(poll, 1500);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!p) return <Spinner label={job?.detail ?? "Building your taste profile… the first run reads your library and a couple of years of seasons."} />;

  const all = Object.entries(p.features);
  const likes = all.filter(([, s]) => s.lift >= 1.3).sort((a, b) => b[1].lift - a[1].lift).slice(0, 20);
  const avoids = all.filter(([, s]) => s.lift <= 0.7).sort((a, b) => a[1].lift - b[1].lift).slice(0, 15);

  return (
    <section>
      <div className="toolbar">
        <h1>Your taste</h1>
        <div className="row">
          <Link to="/quiz" className="button ghost">
            Quiz
          </Link>
          <button className="ghost" disabled={job?.state === "running"} onClick={rebuild}>
            {job?.state === "running" ? job.detail : "Rebuild now"}
          </button>
        </div>
      </div>
      <p className="muted">
        Learned from {p.trainedOn} shows ({p.positives} you kept, watched or liked). "2.0×" means you keep shows with that genre or tag twice as often as average.
        Updated {relTime(p.builtAt)}.
      </p>
      <div className="chips">
        {Object.entries(p.sources).map(([k, v]) => (
          <span key={k} className={`chip${v.startsWith("error") ? " bad" : ""}`}>
            {k}: {v}
          </span>
        ))}
      </div>
      {!likes.length && (
        <p className="banner">
          Not enough to go on yet. <Link to="/settings">Connect Sonarr, Plex or AniList</Link> or <Link to="/quiz">take the quiz</Link>.
        </p>
      )}
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
