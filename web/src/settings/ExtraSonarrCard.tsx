import { useState } from "react";
import { api, type Settings } from "../api";
import { SecretInput, useToast } from "../components/ui";
import { errorMessage } from "../lib/errors";

/** More Sonarr instances (a separate anime or 4K Sonarr): used for "In library" and monitoring. Adds go to the main one. */
export function ExtraSonarrCard({ s, onChange }: { s: Settings; onChange: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: "", url: "", apiKey: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!s.sonarr.url) return null;
  async function add() {
    setBusy(true);
    try {
      await api("/sonarr/extra", { body: form });
      toast(`Added ${form.name || form.url}`);
      setForm({ name: "", url: "", apiKey: "" });
      setOpen(false);
      onChange();
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function remove(i: number) {
    if (!confirm(`Remove ${s.sonarrExtra[i]?.name}? Shows there will no longer count as "You have this".`)) return;
    await api(`/sonarr/extra/${i}`, { method: "DELETE" }).catch((e) => toast(errorMessage(e), true));
    onChange();
  }
  return (
    <div className="card pad stack">
      <h2>Other Sonarr instances</h2>
      <p className="muted small">
        Running a separate anime or 4K Sonarr? Add it so shows there count as "You have this" and can be monitored. New shows are added to
        the main Sonarr above.
      </p>
      {s.sonarrExtra.map((x, i) => (
        <div key={x.url} className="row">
          <strong>{x.name}</strong>
          <span className="muted small">{x.url}</span>
          <button className="ghost small" onClick={() => remove(i)}>
            Remove
          </button>
        </div>
      ))}
      {open ? (
        <div className="form">
          <label>
            Name
            <input value={form.name} placeholder="Sonarr 4K" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Address
            <input value={form.url} placeholder="http://192.168.1.10:8990" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
          <label>
            API key
            <SecretInput label="API key" value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} />
          </label>
          <div className="row end">
            <button className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !form.url || !form.apiKey} onClick={add}>
              {busy ? "Testing…" : "Test & add"}
            </button>
          </div>
        </div>
      ) : (
        <button className="ghost" onClick={() => setOpen(true)}>
          Add another Sonarr
        </button>
      )}
    </div>
  );
}
