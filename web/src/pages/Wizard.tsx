import { useEffect, useState } from "react";
import { api, type Job, type Status } from "../api";
import { Link, navigate } from "../App";
import { ArrCard, AutoDetect, ListsCard, MediaCard, useSettings } from "../connections";
import { usePageTitle } from "../ui";

const STEPS = ["Sonarr & Radarr", "Watch history", "Your taste", "Build"] as const;

/** First-run guide: what each connection is for, all optional, ending with a visible profile build. */
export function Wizard({ status, onDone }: { status: Status; onDone: () => void }) {
  usePageTitle("Set up");
  const { s, setS, save, error } = useSettings();
  const [step, setStep] = useState(0);
  const [job, setJob] = useState<Job | null>(null);

  const reload = () => api("/settings").then((x) => setS(x as never));

  useEffect(() => {
    if (step !== 3) return;
    let alive = true;
    api("/profile/rebuild", { body: {} }).catch(() => undefined);
    const t = setInterval(async () => {
      const sys = await api<{ jobs: Job[] }>("/system").catch(() => null);
      const j = sys?.jobs.find((x) => x.name === "profile") ?? null;
      if (!alive) return;
      setJob(j);
      if (j?.state === "done") {
        clearInterval(t);
        onDone();
        navigate("/");
      }
    }, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [step, onDone]);

  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">Loading…</p>;

  return (
    <section className="wizard">
      <h1>Let's learn your taste</h1>
      <p className="muted">
        Every step is optional. Connect what you have; the more Tastearr can see, the sharper the picks. No *arr apps? Skip to step 3 and use AniList, MAL or the quiz,
        then use Tastearr as a seasonal tracker with streaming links.
      </p>
      <ol className="steps" aria-label="Setup steps">
        {STEPS.map((x, i) => (
          <li key={x} className={i === step ? "on" : i < step ? "done" : ""}>
            <button className="linklike" onClick={() => setStep(i)} disabled={i === 3}>
              {i + 1}. {x}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <AutoDetect onUsed={reload} />
          <ArrCard kind="sonarr" s={s} save={save} />
          <ArrCard kind="radarr" s={s} save={save} />
        </>
      )}
      {step === 1 && <MediaCard s={s} save={save} />}
      {step === 2 && (
        <>
          <ListsCard s={s} save={save} />
          <div className="card pad stack">
            <h2>Or take the quiz</h2>
            <p className="muted small">Two minutes: pick the genres you love or never want, then rate shows you've seen. Works even with nothing else connected.</p>
            <Link to="/quiz" className="button ghost">
              Take the quiz
            </Link>
          </div>
        </>
      )}
      {step === 3 && (
        <div className="card pad stack center">
          <h2>Building your taste profile</h2>
          <div className="progress" role="progressbar" aria-busy="true" aria-label="Building profile">
            <div />
          </div>
          <p className="muted">{job?.state === "error" ? `Something went wrong: ${job.detail}` : (job?.detail ?? "Starting…")}</p>
          <p className="muted small">The first build downloads two years of seasons from AniList and can take a couple of minutes.</p>
        </div>
      )}

      {step < 3 && (
        <div className="row end">
          {step > 0 && (
            <button className="ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button className="primary" onClick={() => setStep(step + 1)}>
            {step === 2 ? "Build my picks" : "Next"}
          </button>
        </div>
      )}
      {status.profileBuiltAt && step < 3 && (
        <p className="muted small">
          Already set up? <Link to="/">Go to your picks</Link>.
        </p>
      )}
    </section>
  );
}
