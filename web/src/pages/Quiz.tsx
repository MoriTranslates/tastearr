import { useEffect, useState } from "react";
import { api, type Pref } from "../api";
import { navigate } from "../App";
import { Spinner, usePageTitle, useToast } from "../ui";

interface QuizShow { id: number; title: string; cover: string | null; year: number | null; genres: string[]; archetype: string; answer: string | null }
interface QuizData { genres: string[]; genrePrefs: Record<string, Pref>; shows: QuizShow[] }

const ANSWERS = [
  { v: "loved", label: "Loved" },
  { v: "liked", label: "Liked" },
  { v: "meh", label: "Meh" },
  { v: "disliked", label: "Disliked" },
] as const;

export function Quiz({ onDone }: { onDone: () => void }) {
  usePageTitle("Taste quiz");
  const toast = useToast();
  const [data, setData] = useState<QuizData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [prefs, setPrefs] = useState<Record<string, Pref>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<QuizData>("/quiz")
      .then((d) => {
        setData(d);
        setPrefs(d.genrePrefs);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function saveGenres() {
    setSaving(true);
    try {
      await api("/quiz/genres", { method: "PUT", body: { genrePrefs: prefs } });
      setStep(2);
      scrollTo(0, 0);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  async function answer(s: QuizShow, v: string) {
    const prev = s.answer;
    const next = prev === v ? null : v;
    const set = (a: string | null) => setData((d) => d && { ...d, shows: d.shows.map((x) => (x.id === s.id ? { ...x, answer: a } : x)) });
    set(next);
    try {
      await api("/feedback", { body: { id: s.id, verdict: next, source: "quiz" } });
    } catch (e) {
      set(prev);
      toast((e as Error).message, true);
    }
  }

  async function finish() {
    setSaving(true);
    try {
      await api("/profile/rebuild", { body: {} });
      onDone();
      toast("Building your picks…");
      navigate("/taste");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Spinner label="Picking shows for the quiz…" />;
  const answered = data.shows.filter((s) => s.answer).length;

  return (
    <section className="quiz">
      <ol className="steps">
        <li className={step === 1 ? "on" : "done"}>1. Genres</li>
        <li className={step === 2 ? "on" : ""}>2. Shows you've seen</li>
      </ol>

      {step === 1 && (
        <>
          <h1>What do you watch?</h1>
          <p className="muted">"Never" hides that genre from your picks. Leave anything you're unsure about on OK.</p>
          <div className="genre-list">
            {data.genres.map((g) => (
              <div key={g} className="genre-row card">
                <span id={`g-${g}`}>{g}</span>
                <div className="seg" role="radiogroup" aria-labelledby={`g-${g}`}>
                  {(["love", "ok", "never"] as Pref[]).map((v) => {
                    const on = (prefs[g] ?? "ok") === v;
                    return (
                      <button key={v} role="radio" aria-checked={on} className={on ? `on ${v}` : ""} onClick={() => setPrefs({ ...prefs, [g]: v })}>
                        {v === "love" ? "Love" : v === "ok" ? "OK" : "Never"}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="row end">
            <button className="primary" disabled={saving} onClick={saveGenres}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h1>Rate shows you've seen</h1>
          <p className="muted">Skip anything you haven't watched. About 10 answers is enough to start; more makes the picks sharper. ({answered} answered)</p>
          <div className="quiz-grid">
            {data.shows.map((s) => (
              <div key={s.id} className={`quiz-card card${s.answer ? " done" : ""}`}>
                {s.cover ? <img src={s.cover} alt="" loading="lazy" /> : <div className="noimg" />}
                <div className="body">
                  <h3>{s.title}</h3>
                  <p className="meta">{[s.year, s.archetype].filter(Boolean).join(" · ")}</p>
                  <div className="seg small" role="radiogroup" aria-label={`Your rating for ${s.title}`}>
                    {ANSWERS.map((a) => {
                      const on = s.answer === a.v;
                      return (
                        <button key={a.v} role="radio" aria-checked={on} className={on ? `on ${a.v}` : ""} onClick={() => answer(s, a.v)}>
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="row end">
            <button className="ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="primary" disabled={saving} onClick={finish}>
              {saving ? "Starting…" : "Build my picks"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
