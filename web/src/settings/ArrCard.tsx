import { useEffect, useState } from "react";
import { api, type ArrOptions, type Settings } from "../api";
import { Chips, Pill, SecretInput, useToast } from "../components/ui";
import { unsaved } from "./unsaved";
import type { Save } from "./useSettings";

export function ArrCard({ kind, s, save, onSaved }: { kind: "sonarr" | "radarr"; s: Settings; save: Save; onSaved?: () => void }) {
  const toast = useToast();
  const cfg = s[kind];
  const [url, setUrl] = useState(cfg.url);
  const [apiKey, setApiKey] = useState(cfg.apiKey);
  const [opts, setOpts] = useState<ArrOptions | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState(cfg);
  const [busy, setBusy] = useState(false);
  const name = kind === "sonarr" ? "Sonarr" : "Radarr";

  async function test(quiet = false) {
    setBusy(true);
    try {
      const r = await api<{ version: string; options: ArrOptions }>(`/${kind}/test`, { body: { url, apiKey } });
      setVersion(r.version);
      setFailed(false);
      setOpts(r.options);
    } catch (e) {
      setVersion(null);
      setFailed(true);
      if (!quiet) toast(`${name}: ${(e as Error).message}`, true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (cfg.url && cfg.apiKey) void test(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    setBusy(true);
    try {
      const next = await save({ [kind]: { ...draft, url, apiKey } } as Partial<Settings>);
      setApiKey(next[kind].apiKey);
      setUrl(next[kind].url);
      setDraft(next[kind]);
      toast(`${name} saved`);
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  // Lets the setup guide warn before "Next" throws away an address or key that wasn't saved.
  const dirty = url !== cfg.url || apiKey !== cfg.apiKey || JSON.stringify(draft) !== JSON.stringify(cfg);
  useEffect(() => {
    if (dirty) unsaved.add(name);
    else unsaved.delete(name);
    return () => void unsaved.delete(name);
  }, [dirty, name]);
  const connected = !!cfg.url && !!cfg.apiKey;
  return (
    <div className="card pad stack">
      <div className="card-head">
        <h2>{name}</h2>
        <Pill ok={version ? true : failed || !connected ? false : null}>
          {version ? `Connected · v${version}` : failed ? "Can't connect" : connected ? "Saved" : "Not set up"}
        </Pill>
      </div>
      <p className="muted small">
        {kind === "sonarr" ? (
          <>
            Tastearr reads your series list to learn what you picked, and adds anime you choose. It only changes Sonarr when you press{" "}
            <em>Add</em>, <em>Monitor</em> or <em>Not into it</em>, and it never deletes anything.
          </>
        ) : (
          <>Same as Sonarr, for anime movies: Tastearr reads your movie list and adds the movies you pick. It never deletes anything.</>
        )}
      </p>
      <div className="form">
        <label>
          Address
          <input
            value={url}
            placeholder={kind === "sonarr" ? "http://192.168.1.10:8989" : "http://192.168.1.10:7878"}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          API key <span className="muted small">(Settings → General in {name})</span>
          <SecretInput label={`${name} API key`} value={apiKey} onChange={setApiKey} />
        </label>
      </div>
      <div className="row">
        <button className="ghost" disabled={busy || !url} onClick={() => test()}>
          Test
        </button>
      </div>
      {opts && (
        <div className="form">
          <label>
            Quality profile for {kind === "sonarr" ? "anime" : "anime movies"}
            <select
              value={draft.qualityProfileId ?? ""}
              onChange={(e) => setDraft({ ...draft, qualityProfileId: Number(e.target.value) || null })}
            >
              <option value="">Choose…</option>
              {opts.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Root folder
            <select value={draft.rootFolderPath} onChange={(e) => setDraft({ ...draft, rootFolderPath: e.target.value })}>
              <option value="">Choose…</option>
              {opts.roots.map((r) => (
                <option key={r.id} value={r.path}>
                  {r.path}
                </option>
              ))}
            </select>
          </label>
          <div className="field wide">
            <span>Tags to add (a "tastearr" tag is always added too)</span>
            <Chips
              label="Tags"
              options={opts.tags.map((t) => ({ id: t.id, label: t.label }))}
              value={draft.tags}
              onChange={(tags) => setDraft({ ...draft, tags })}
            />
          </div>
          {kind === "sonarr" && "sequelMonitor" in draft && (
            <>
              <label>
                Sequels of shows you don't have
                <select
                  value={draft.sequelMonitor}
                  onChange={(e) => setDraft({ ...draft, sequelMonitor: e.target.value as "newSeason" | "all" })}
                >
                  <option value="newSeason">Only monitor the new season</option>
                  <option value="all">Monitor every season</option>
                </select>
              </label>
              <label>
                "Not into it anymore"
                <select
                  value={draft.dropAction}
                  onChange={(e) => setDraft({ ...draft, dropAction: e.target.value as "unmonitor" | "keep" })}
                >
                  <option value="unmonitor">Unmonitor the series in Sonarr</option>
                  <option value="keep">Only stop alerts</option>
                </select>
              </label>
            </>
          )}
          {kind === "radarr" && "minimumAvailability" in draft && (
            <label>
              Minimum availability
              <select
                value={draft.minimumAvailability}
                onChange={(e) => setDraft({ ...draft, minimumAvailability: e.target.value as "announced" | "inCinemas" | "released" })}
              >
                <option value="released">Released</option>
                <option value="inCinemas">In cinemas</option>
                <option value="announced">Announced</option>
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={draft.searchOnAdd} onChange={(e) => setDraft({ ...draft, searchOnAdd: e.target.checked })} />{" "}
            Search as soon as it's added
          </label>
        </div>
      )}
      <div className="row end">
        <button className="primary" disabled={busy || !url} onClick={submit}>
          Save {name}
        </button>
      </div>
    </div>
  );
}
