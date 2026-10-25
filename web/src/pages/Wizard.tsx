import { useEffect, useRef, useState } from "react";
import { api, type Job, type Status } from "../api";
import { Link, navigate } from "../App";
import { AlertsCard, ArrCard, AutoDetect, ListsCard, MediaCard, useSettings } from "../connections";
import { usePageTitle } from "../ui";

type Mode = "server" | "stream";
const STEPS: Record<Mode, string[]> = {
  server: ["Download apps", "Watch history", "Your taste", "Finish"],
  stream: ["Your taste", "Alerts (optional)", "Finish"],
};

/** First-run guide. Starts by asking how the person watches, so streaming-only users never see server jargon. */
export function Wizard({ status, onDone }: { status: Status; onDone: () => void }) {
  usePageTitle("Get started");
  const { s, setS, save, error } = useSettings();
  const [mode, setMode] = useState<Mode | null>(status.mode ? (status.mode as Mode) : null);
  const [step, setStep] = useState(0);

  const choose = async (m: Mode) => {
    setMode(m);
    setStep(0);
    await save({ mode: m }).catch(() => undefined);
  };
  const saveAndRefresh: typeof save = async (patch) => {
    const r = await save(patch);
    onDone();
    return r;
  };

  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">Loading…</p>;

  if (!mode)
    return (
      <section className="wizard">
        <h1>Let's find anime you'll like</h1>
        <p className="muted">How do you usually watch?</p>
        <div className="choice-grid">
          <button className="choice card" onClick={() => choose("stream")}>
            <strong>I stream it</strong>
            <span className="muted small">Crunchyroll, Netflix, HIDIVE… Tastearr learns your taste from a short quiz or your AniList list, then shows what's worth watching and where.</span>
          </button>
          <button className="choice card" onClick={() => choose("server")}>
            <strong>I have a media server</strong>
            <span className="muted small">Sonarr, Radarr, Plex or Jellyfin. Tastearr learns from your library and can add shows for you.</span>
          </button>
        </div>
        {status.profileBuiltAt ? (
          <p className="muted small">
            Already set up? <Link to="/">Go to your picks</Link>.
          </p>
        ) : null}
      </section>
    );

  const steps = STEPS[mode];
  const last = step === steps.length - 1;
  const name = steps[step];

  return (
    <section className="wizard">
      <h1>Let's find anime you'll like</h1>
      <ol className="steps" aria-label="Setup steps">
        {steps.map((x, i) => (
          <li key={x} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
            {i < step ? "✓ " : `${i + 1}. `}
            {x}
          </li>
        ))}
      </ol>

      {name === "Download apps" && (
        <>
          <p className="muted small">Connect Sonarr (shows) and Radarr (movies) if you use them. Skip either one with Next.</p>
          <AutoDetect onUsed={() => api("/settings").then((x) => setS(x as never))} />
          <ArrCard kind="sonarr" s={s} save={saveAndRefresh} />
          <ArrCard kind="radarr" s={s} save={saveAndRefresh} />
        </>
      )}
      {name === "Watch history" && <MediaCard s={s} save={saveAndRefresh} />}
      {name === "Your taste" && (
        <>
          <ListsCard s={s} save={saveAndRefresh} />
          <div className="card pad stack">
            <h2>Or take the 2-minute quiz</h2>
            <p className="muted small">Pick the kinds of anime you love or never want, then rate a few shows you've seen. You can do this as well as AniList.</p>
            <Link to="/quiz?from=setup" className="button primary">
              Take the quiz
            </Link>
          </div>
        </>
      )}
      {name === "Alerts (optional)" && (
        <>
          <p className="muted small">Want a ping on your phone when a show you follow has a new episode? Set it up now or skip it and do it later in Settings.</p>
          <AlertsCard s={s} save={saveAndRefresh} simple />
        </>
      )}
      {name === "Finish" && <Build status={status} onDone={onDone} />}

      <div className="row end">
        <button className="ghost" onClick={() => (step === 0 ? setMode(null) : setStep(step - 1))}>
          Back
        </button>
        {!last && (
          <button className="primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}

/** Starts a profile build and follows it, with a clear message if there's nothing to learn from yet. */
function Build({ status, onDone }: { status: Status; onDone: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(0);
  const nothing = !status.sonarr && !status.radarr && !status.media && !status.lists && !status.quizAnswers;

  useEffect(() => {
    if (nothing) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setError(null);
    started.current = Date.now();
    const poll = async () => {
      try {
        const sys = await api<{ jobs: Job[] }>("/system");
        const j = sys.jobs.find((x) => x.name === "profile") ?? null;
        if (!alive) return;
        setJob(j);
        // Only a build that started after we asked counts.
        if (j && (j.startedAt ?? 0) >= started.current - 2000) {
          if (j.state === "done") {
            onDone();
            navigate("/");
            return;
          }
          if (j.state === "error") return setError(j.detail);
        }
        timer = setTimeout(poll, 1500);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    api("/profile/rebuild", { body: {} })
      .then(() => (timer = setTimeout(poll, 800)))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [attempt, nothing, onDone]);

  if (nothing)
    return (
      <div className="card pad stack center">
        <h2>Nothing to learn from yet</h2>
        <p className="muted">Go back and connect something, link your AniList, or take the quiz. Tastearr needs at least one of them.</p>
        <Link to="/quiz?from=setup" className="button primary">
          Take the quiz
        </Link>
      </div>
    );

  return (
    <div className="card pad stack center">
      <h2>Getting your picks ready</h2>
      {!error && (
        <div className="progress" role="progressbar" aria-busy="true" aria-label="Building your taste profile">
          <div />
        </div>
      )}
      <p className={error ? "error" : "muted"}>{error ? `That didn't work: ${error}` : (job?.detail ?? "Starting…")}</p>
      {error ? (
        <button className="primary" onClick={() => setAttempt((x) => x + 1)}>
          Try again
        </button>
      ) : (
        <p className="muted small">The first time takes a minute or two while Tastearr downloads recent seasons from AniList.</p>
      )}
    </div>
  );
}
