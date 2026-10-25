import { useEffect, useState } from "react";
import { api, type Pref } from "../api";
import { navigate } from "../App";
import { ErrorBox, Spinner, usePageTitle, useToast } from "../ui";

interface QuizShow { id: number; title: string; cover: string | null; year: number | null; genres: string[]; archetype: string; answer: string | null }
interface Option { key: string; label: string }
interface QuizData { genres: Option[]; themes: Option[]; noGore: boolean; genrePrefs: Record<string, Pref>; shows: QuizShow[] }
interface Found { id: number; title: string; cover: string | null; year: number | null; format: string | null }

const ANSWERS = [
  { v: "loved", label: "Loved" },
  { v: "liked", label: "Liked" },
  { v: "meh", label: "Meh" },
  { v: "disliked", label: "Disliked" },
] as const;

function PrefRow({ o, value, onChange }: { o: Option; value: Pref; onChange: (v: Pref) => void }) {
  const id = `p-${o.key.replace(/\W/g, "")}`;
  return (
    <div className="genre-row card">
      <span id={id}>{o.label}</span>
      <div className="seg" role="radiogroup" aria-labelledby={id}>
        {(["love", "ok", "never"] as Pref[]).map((v) => (
          <button key={v} role="radio" aria-checked={value === v} className={value === v ? `on ${v}` : ""} onClick={() => onChange(v)}>
            {v === "love" ? "♥ Love" : v === "ok" ? "OK" : "✗ Never"}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Quiz({ onDone }: { onDone: () => void }) {
  usePageTitle("Taste quiz");
  const toast = useToast();
  const [data, setData] = useState<QuizData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [prefs, setPrefs] = useState<Record<string, Pref>>({});
  const [noGore, setNoGore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    api<QuizData>("/quiz")
      .then((d) => {
        setData(d);
        setPrefs(d.genrePrefs);
        setNoGore(d.noGore);
      })
      .catch((e) => setError(e.message));
  }, [reload]);

  async function saveGenres() {
    setSaving(true);
    try {
      await api("/quiz/genres", { method: "PUT", body: { genrePrefs: prefs } });
      await api("/quiz/content", { method: "PUT", body: { noGore } });
      setStep(2);
      scrollTo(0, 0);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  async function answer(s: { id: number }, v: string, current: string | null) {
    const next = current === v ? null : v;
    const set = (a: string | null) => setData((d) => d && { ...d, shows: d.shows.map((x) => (x.id === s.id ? { ...x, answer: a } : x)) });
    set(next);
    try {
      await api("/feedback", { body: { id: s.id, verdict: next, source: "quiz" } });
    } catch (e) {
      set(current);
      toast((e as Error).message, true);
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim().length < 2) return;
    try {
      setFound(await api<Found[]>(`/quiz/search?q=${encodeURIComponent(q.trim())}`));
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  function addFound(f: Found) {
    setData((d) => (d && !d.shows.some((x) => x.id === f.id) ? { ...d, shows: [{ id: f.id, title: f.title, cover: f.cover, year: f.year, genres: [], archetype: "Added by you", answer: null }, ...d.shows] } : d));
    setFound(null);
    setQ("");
  }

  async function finish() {
    setSaving(true);
    try {
      await api("/profile/rebuild", { body: {} });
      onDone();
      toast("Getting your picks ready…");
      navigate("/");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorBox error={error} retry={() => setReload((x) => x + 1)} />;
  if (!data) return <Spinner label="Picking shows for the quiz… the first time takes a few seconds while Tastearr asks AniList." />;
  const answered = data.shows.filter((s) => s.answer).length;

  return (
    <section className="quiz">
      <ol className="steps">
        <li className={step === 1 ? "on" : "done"}>{step === 1 ? "1." : "✓"} What you like</li>
        <li className={step === 2 ? "on" : ""}>2. Shows you've seen</li>
      </ol>

      {step === 1 && (
        <>
          <h1>What do you like to watch?</h1>
          <p className="muted">"Love" pushes those shows up. "Never" hides them. Leave anything you're unsure about on OK.</p>
          <h2>Kinds of anime</h2>
          <div className="genre-list">
            {data.genres.map((g) => (
              <PrefRow key={g.key} o={g} value={prefs[g.key] ?? "ok"} onChange={(v) => setPrefs({ ...prefs, [g.key]: v })} />
            ))}
          </div>
          <h2>Themes</h2>
          <div className="genre-list">
            {data.themes.map((t) => (
              <PrefRow key={t.key} o={t} value={prefs[t.key] ?? "ok"} onChange={(v) => setPrefs({ ...prefs, [t.key]: v })} />
            ))}
          </div>
          <label className="check card pad">
            <input type="checkbox" checked={noGore} onChange={(e) => setNoGore(e.target.checked)} /> Hide shows with gore or graphic violence
          </label>
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
          <p className="muted">Skip anything you haven't watched. About 10 answers is plenty to start. ({answered} so far)</p>
          <form className="row" onSubmit={search} role="search">
            <input type="search" placeholder="Add a show you've seen, e.g. Frieren" aria-label="Find a show you've seen" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="ghost">Find</button>
          </form>
          {found && (
            <div className="cand-list">
              {!found.length && <p className="muted small">Nothing found.</p>}
              {found.map((f) => (
                <button key={f.id} className="cand row" onClick={() => addFound(f)}>
                  {f.cover && <img src={f.cover} alt="" width={32} height={45} />}
                  <span>
                    <strong>{f.title}</strong> <span className="muted small">{[f.year, f.format?.replace("_", " ")].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
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
                        <button key={a.v} role="radio" aria-checked={on} className={on ? `on ${a.v}` : ""} onClick={() => answer(s, a.v, s.answer)}>
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="row end sticky-actions">
            <button className="ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="primary" disabled={saving} onClick={finish}>
              {saving ? "Starting…" : "Show my picks"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
