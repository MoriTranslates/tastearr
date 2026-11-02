import { useEffect, useState } from "react";
import { api, type Settings as S } from "../api";
import { NumberInput, useToast } from "../components/ui";
import { relTime } from "../lib/format";

interface AutoPick {
  id: number;
  title: string;
  match: number;
  season: string;
  year: number;
  action: string;
}
interface AutoDone {
  id: number;
  title: string;
  season: string;
  year: number;
  match: number;
  detail: string;
  at: number;
}

/** Auto-add: like an import list, but driven by match %. Off until the user turns it on. */
export function AutoAddCard({ s, save }: { s: S; save: (p: Partial<S>) => Promise<S> }) {
  const toast = useToast();
  const [a, setA] = useState(s.autoAdd);
  const [preview, setPreview] = useState<AutoPick[] | null>(null);
  const [history, setHistory] = useState<AutoDone[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<AutoDone[]>("/autoadd/history")
      .then(setHistory)
      .catch(() => undefined);
  }, []);

  async function submit() {
    setBusy(true);
    try {
      await save({ autoAdd: a });
      toast(a.enabled ? "Saved. Auto-add runs with the next refresh (every 6 hours), or press Run now." : "Saved");
      setPreview(null);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function showPreview() {
    setBusy(true);
    try {
      await save({ autoAdd: a });
      setPreview((await api<{ picks: AutoPick[] }>("/autoadd/preview")).picks);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function runNow() {
    if (!confirm(`Add ${preview?.length ?? "the matching"} show(s) to Sonarr/Radarr now?`)) return;
    setBusy(true);
    try {
      const r = await api<{ added: { title: string; detail: string }[] }>("/autoadd/run", { body: {} });
      toast(r.added.length ? `Added ${r.added.length}: ${r.added.map((x) => x.title).join(", ")}` : "Nothing new to add");
      setPreview(null);
      setHistory(await api<AutoDone[]>("/autoadd/history"));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pad stack">
      <h2>Auto-add</h2>
      <p className="muted small">
        Sends picks at or above a match % to Sonarr/Radarr by itself, for this season and next, like an import list. It never adds shorts,
        rough guesses, shows you've hidden, 👎'd, seen or are watching, or shows without a confirmed Sonarr match. Sequels get only their
        new season, and each show is added at most once (remove it from Sonarr and it stays removed). You get an alert listing what was
        added.
      </p>
      <div className="form">
        <label className="check">
          <input type="checkbox" checked={a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} /> Turn on auto-add
        </label>
        <label>
          Add when the match is at least
          <NumberInput label="Minimum match %" min={50} max={100} value={a.minMatch} onChange={(v) => setA({ ...a, minMatch: v })} />
        </label>
        <label>
          At most this many per season
          <NumberInput label="Per season" min={1} max={50} value={a.maxPerSeason} onChange={(v) => setA({ ...a, maxPerSeason: v })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={a.sequels} onChange={(e) => setA({ ...a, sequels: e.target.checked })} /> New seasons of shows
          (Continuing)
        </label>
        <label className="check">
          <input type="checkbox" checked={a.newShows} onChange={(e) => setA({ ...a, newShows: e.target.checked })} /> Brand-new shows
        </label>
        <label className="check">
          <input type="checkbox" checked={a.movies} onChange={(e) => setA({ ...a, movies: e.target.checked })} /> Movies (Radarr)
        </label>
        <label className="check">
          <input type="checkbox" checked={a.search} onChange={(e) => setA({ ...a, search: e.target.checked })} /> Start searching right away
        </label>
      </div>
      <div className="row end">
        <button className="ghost" disabled={busy} onClick={showPreview}>
          What would it add?
        </button>
        <button className="primary" disabled={busy} onClick={submit}>
          Save
        </button>
      </div>
      {preview && (
        <div className="stack">
          {!preview.length && <p className="muted small">Nothing right now at {a.minMatch}% or above.</p>}
          {preview.length > 0 && (
            <>
              <ul className="plan small">
                {preview.map((p) => (
                  <li key={p.id}>
                    {p.title} · {p.match}% → {p.action}
                  </li>
                ))}
              </ul>
              {a.enabled && (
                <div className="row end">
                  <button className="primary" disabled={busy} onClick={runNow}>
                    Run now
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary>Added automatically ({history.length})</summary>
          <ul className="plan small">
            {history.map((h) => (
              <li key={h.id}>
                {h.title} · {h.match}% → {h.detail} · {relTime(h.at)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
