import { useState } from "react";
import { api, type Settings } from "../api";
import { Pill, SecretInput, useToast } from "../components/ui";
import type { Save } from "./useSettings";
import { errorMessage } from "../lib/errors";

export function ListsCard({ s, save, onSaved }: { s: Settings; save: Save; onSaved?: () => void }) {
  const toast = useToast();
  const [lists, setLists] = useState(s.lists);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({ lists });
      const r = await api<{ imported: string[] }>("/lists/import", { body: {} });
      toast(r.imported.length ? `Imported ${r.imported.join(" and ")}. Rebuilding your taste…` : "Saved");
      onSaved?.();
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card pad stack">
      <div className="card-head">
        <h2>AniList / MyAnimeList</h2>
        <Pill ok={s.lists.anilistUser || s.lists.malUser ? true : false}>
          {s.lists.anilistUser || s.lists.malUser ? "Linked" : "Not set up"}
        </Pill>
      </div>
      <p className="muted small">
        The fastest way to teach Tastearr: your public list's completed shows, scores and drops. Only the username is needed for AniList.
      </p>
      <div className="form">
        <label>
          AniList username
          <input
            value={lists.anilistUser}
            placeholder="e.g. morisato"
            onChange={(e) => setLists({ ...lists, anilistUser: e.target.value })}
          />
        </label>
        <label>
          MyAnimeList username
          <input value={lists.malUser} onChange={(e) => setLists({ ...lists, malUser: e.target.value })} />
        </label>
        {lists.malUser && (
          <label>
            MAL API client ID{" "}
            <a className="small" href="https://myanimelist.net/apiconfig" target="_blank" rel="noreferrer">
              (get one free)
            </a>
            <SecretInput label="MAL client ID" value={lists.malClientId} onChange={(v) => setLists({ ...lists, malClientId: v })} />
          </label>
        )}
      </div>
      <div className="row end">
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? "Importing…" : "Save & import"}
        </button>
      </div>
    </div>
  );
}
