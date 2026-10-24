import { useEffect, useState } from "react";
import { api, type Pref } from "../api";
import { navigate } from "../App";

interface QuizShow { id: number; title: string; cover: string | null; color: string | null; year: number | null; genres: string[]; answer: string | null }
interface QuizData { genres: string[]; genrePrefs: Record<string, Pref>; shows: QuizShow[] }

const ANSWERS = [
  { v: "loved", label: "Loved" },
  { v: "liked", label: "Liked" },
  { v: "meh", label: "Meh" },
  { v: "disliked", label: "Disliked" },
] as const;

export function Quiz() {
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
    await api("/quiz/genres", { method: "PUT", body: { genrePrefs: prefs } }).catch((e) => setError(e.message));
    setSaving(false);
    setStep(2);
    scrollTo(0, 0);
  }

  async function answer(s: QuizShow, v: string) {
    const next = s.answer === v ? null : v;
    setData((d) => d && { ...d, shows: d.shows.map((x) => (x.id === s.id ? { ...x, answer: next } : x)) });
    await api("/feedback", { body: { id: s.id, verdict: next, source: "quiz" } }).catch((e) => setError(e.message));
  }

  async function finish() {
    setSaving(true);
    await api("/profile/rebuild", { body: {} }).catch((e) => setError(e.message));
    setSaving(false);
    navigate("/");
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading the quiz…</p>;
  const answered = data.shows.filter((s) => s.answer).length;

  return (
    <section className="quiz">
      <div className="steps">
        <span className={step === 1 ? "on" : ""}>1. Genres</span>
        <span className={step === 2 ? "on" : ""}>2. Shows you've seen</span>
      </div>

      {step === 1 && (
        <>
          <h1>What do you watch?</h1>
          <p className="muted">"Never" hides that genre from your picks completely. Leave anything you're unsure about on OK.</p>
          <div className="genre-list">
            {data.genres.map((g) => (
              <div key={g} className="genre-row card">
                <span>{g}</span>
                <div className="seg">
                  {(["love", "ok", "never"] as Pref[]).map((v) => (
                    <button key={v} className={(prefs[g] ?? "ok") === v ? `on ${v}` : ""} onClick={() => setPrefs({ ...prefs, [g]: v })}>
                      {v === "love" ? "Love" : v === "ok" ? "OK" : "Never"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="actions end">
            <button className="primary" disabled={saving} onClick={saveGenres}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h1>Rate shows you've seen</h1>
          <p className="muted">Skip anything you haven't watched. Around 10 answers is enough to get going; more makes the picks sharper. ({answered} answered)</p>
          <div className="quiz-grid">
            {data.shows.map((s) => (
              <div key={s.id} className={`quiz-card card${s.answer ? " done" : ""}`}>
                {s.cover ? <img src={s.cover} alt="" loading="lazy" /> : <div className="noimg" />}
                <div className="body">
                  <h3>{s.title}</h3>
                  <p className="meta">{[s.year, s.genres.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}</p>
                  <div className="seg small">
                    {ANSWERS.map((a) => (
                      <button key={a.v} className={s.answer === a.v ? `on ${a.v}` : ""} onClick={() => answer(s, a.v)}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="actions end">
            <button className="ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="primary" disabled={saving} onClick={finish}>
              {saving ? "Building your profile…" : "See my picks"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
