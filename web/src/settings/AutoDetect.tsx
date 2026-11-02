import { useState } from "react";
import { api } from "../api";
import { useToast } from "../components/ui";
import { errorMessage } from "../lib/errors";

interface Found {
  id: string;
  app: "sonarr" | "radarr";
  folder: string;
  port: number;
  url: string | null;
  usable: boolean;
}

export function AutoDetect({ onUsed }: { onUsed: () => void }) {
  const toast = useToast();
  const [res, setRes] = useState<{ appdata: boolean; docker: boolean; found: Found[] } | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function scan() {
    setBusy(true);
    try {
      const r = await api<{ appdata: boolean; docker: boolean; found: Found[] }>("/discover");
      setRes(r);
      setUrls(Object.fromEntries(r.found.map((f) => [f.id, f.url ?? ""])));
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function use(f: Found) {
    try {
      await api("/discover/use", { body: { id: f.id, url: urls[f.id] } });
      toast(`Using ${f.folder} for ${f.app === "sonarr" ? "Sonarr" : "Radarr"}`);
      onUsed();
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }

  return (
    <div className="card pad stack">
      <h2>Find my apps</h2>
      <p className="muted small">
        If Sonarr's or Radarr's config folder is mounted into Tastearr (read-only, at <code>/appdata</code>), Tastearr can read the API key
        itself. You only confirm the address.
      </p>
      <button className="ghost" disabled={busy} onClick={scan}>
        {busy ? "Looking…" : "Look for Sonarr and Radarr"}
      </button>
      {res && !res.appdata && <p className="muted small">No config folder is mounted, so enter the details below instead.</p>}
      {res?.appdata && !res.found.length && <p className="muted small">Nothing found in /appdata.</p>}
      {res?.found.map((f) => (
        <div key={f.id} className="found">
          <strong>{f.app === "sonarr" ? "Sonarr" : "Radarr"}</strong>
          <span className="muted small">{f.folder}</span>
          {f.usable ? (
            <>
              <input
                aria-label={`${f.folder} address`}
                value={urls[f.id] ?? ""}
                placeholder={`http://server-ip:${f.port}`}
                onChange={(e) => setUrls({ ...urls, [f.id]: e.target.value })}
              />
              <button className="primary small" disabled={!urls[f.id]} onClick={() => use(f)}>
                Use
              </button>
            </>
          ) : (
            <span className="muted small">Enter this one below.</span>
          )}
        </div>
      ))}
    </div>
  );
}
