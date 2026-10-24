import { useEffect, useState } from "react";
import { api, type Settings as S } from "../api";

interface Found { app: "sonarr" | "radarr" | "plex"; folder: string; apiKey: string; port: number; url: string | null }
interface Options { profiles: { id: number; name: string }[]; roots: { id: number; path: string }[]; tags: { id: number; label: string }[] }
type Lib = { id: string; title: string };

const csv = (a: string[]) => a.join(", ");
const uncsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function Settings({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<S | null>(null);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [found, setFound] = useState<{ appdata: boolean; docker: boolean; found: Found[] } | null>(null);
  const [opts, setOpts] = useState<Options | null>(null);
  const [libs, setLibs] = useState<Lib[] | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<S>("/settings").then((x) => {
      setS(x);
      if (x.sonarr.url) api<Options>("/sonarr/options").then(setOpts).catch(() => undefined);
      if (x.media.type !== "none" && x.media.url) api<Lib[]>("/media/libraries", { body: x.media }).then(setLibs).catch(() => undefined);
    });
  }, []);

  if (!s) return <p className="muted">Loading settings…</p>;

  const set = <K extends keyof S>(k: K, v: Partial<S[K]>) => setS({ ...s, [k]: typeof s[k] === "object" ? { ...(s[k] as object), ...v } : v });
  const note = (k: string, v: string) => setMsg((m) => ({ ...m, [k]: v }));

  async function run(key: string, f: () => Promise<string>) {
    note(key, "…");
    try {
      note(key, await f());
    } catch (e) {
      note(key, `✗ ${(e as Error).message}`);
    }
  }

  const testSonarr = () =>
    run("sonarr", async () => {
      const r = await api<{ version: string }>("/test/sonarr", { body: { url: s.sonarr.url, apiKey: s.sonarr.apiKey } });
      await save(true);
      setOpts(await api<Options>("/sonarr/options"));
      return `✓ Connected to Sonarr ${r.version}`;
    });

  const testMedia = () =>
    run("media", async () => {
      const r = await api<{ name: string; version: string }>("/test/media", { body: s.media });
      if (s.media.type === "jellyfin" && !s.media.userId) {
        setUsers(await api("/media/users", { body: s.media }));
        return `✓ ${r.name} ${r.version}. Pick your user below, then test again.`;
      }
      setLibs(await api<Lib[]>("/media/libraries", { body: s.media }));
      return `✓ Connected to ${r.name} ${r.version}`;
    });

  async function autodetect() {
    await run("discover", async () => {
      const r = await api<{ appdata: boolean; docker: boolean; found: Found[] }>("/discover");
      setFound(r);
      if (!r.appdata) return "No appdata folder mounted. Mount your appdata at /appdata (read-only) to use this.";
      return `Found ${r.found.length} app${r.found.length === 1 ? "" : "s"}${r.docker ? "" : " (mount the Docker socket to fill in addresses too)"}`;
    });
  }

  function useFound(f: Found) {
    if (f.app === "sonarr") set("sonarr", { url: f.url ?? s!.sonarr.url, apiKey: f.apiKey });
    if (f.app === "plex") set("media", { type: "plex", url: f.url ?? s!.media.url, token: f.apiKey });
  }

  async function save(quiet = false) {
    setSaving(true);
    try {
      const x = await api<S>("/settings", { method: "PUT", body: { settings: s, password: password || undefined } });
      setS(x);
      setPassword("");
      if (!quiet) note("save", "✓ Saved");
      onSaved();
    } catch (e) {
      note("save", `✗ ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const base = s.externalUrl || location.origin;
  const webhook = `${base}/api/webhook/sonarr?apikey=${s.apiKey}`;

  return (
    <section className="settings">
      <div className="toolbar">
        <h1>Settings</h1>
        <div className="actions">
          {msg.save && <span className="note">{msg.save}</span>}
          <button className="primary" disabled={saving} onClick={() => save()}>
            Save
          </button>
        </div>
      </div>

      <div className="card pad">
        <h2>Auto-detect</h2>
        <p className="muted small">Reads API keys from your appdata folder (mount it read-only at /appdata). Mount /var/run/docker.sock read-only too and it fills in addresses.</p>
        <button className="ghost" onClick={autodetect}>
          Find my apps
        </button>
        {msg.discover && <span className="note">{msg.discover}</span>}
        {found?.found.map((f) => (
          <div key={f.folder + f.app} className="found">
            <strong>{f.app}</strong> <span className="muted">{f.folder}</span> <code>{f.url ?? `port ${f.port}`}</code>
            {f.app !== "radarr" && (
              <button className="ghost small" onClick={() => useFound(f)}>
                Use
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="card pad">
        <h2>Sonarr</h2>
        <div className="form">
          <label>
            URL <input value={s.sonarr.url} placeholder="http://192.168.1.10:8989" onChange={(e) => set("sonarr", { url: e.target.value })} />
          </label>
          <label>
            API key <input value={s.sonarr.apiKey} onChange={(e) => set("sonarr", { apiKey: e.target.value })} />
          </label>
        </div>
        <button className="ghost" onClick={testSonarr}>
          Test & load options
        </button>
        {msg.sonarr && <span className="note">{msg.sonarr}</span>}
        {opts && (
          <div className="form">
            <label>
              Quality profile
              <select value={s.sonarr.qualityProfileId ?? ""} onChange={(e) => set("sonarr", { qualityProfileId: Number(e.target.value) || null })}>
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
              <select value={s.sonarr.rootFolderPath} onChange={(e) => set("sonarr", { rootFolderPath: e.target.value })}>
                <option value="">Choose…</option>
                {opts.roots.map((r) => (
                  <option key={r.id} value={r.path}>
                    {r.path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tags
              <select multiple value={s.sonarr.tags.map(String)} onChange={(e) => set("sonarr", { tags: [...e.target.selectedOptions].map((o) => Number(o.value)) })}>
                {opts.tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sequels of shows you don't have
              <select value={s.sonarr.sequelMonitor} onChange={(e) => set("sonarr", { sequelMonitor: e.target.value as "newSeason" | "all" })}>
                <option value="newSeason">Only monitor the new season</option>
                <option value="all">Monitor every season</option>
              </select>
            </label>
            <label>
              "Not into it" in Sonarr
              <select value={s.sonarr.dropAction} onChange={(e) => set("sonarr", { dropAction: e.target.value as "unmonitor" | "keep" })}>
                <option value="unmonitor">Unmonitor the series</option>
                <option value="keep">Leave it alone</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={s.sonarr.searchOnAdd} onChange={(e) => set("sonarr", { searchOnAdd: e.target.checked })} /> Search for episodes when adding
            </label>
          </div>
        )}
      </div>

      <div className="card pad">
        <h2>Watch history</h2>
        <p className="muted small">Finished shows count toward your taste; ones you drop early count against.</p>
        <div className="form">
          <label>
            Server
            <select value={s.media.type} onChange={(e) => set("media", { type: e.target.value as S["media"]["type"] })}>
              <option value="none">None</option>
              <option value="plex">Plex</option>
              <option value="jellyfin">Jellyfin / Emby</option>
            </select>
          </label>
          {s.media.type !== "none" && (
            <>
              <label>
                URL <input value={s.media.url} placeholder={s.media.type === "plex" ? "http://192.168.1.10:32400" : "http://192.168.1.10:8096"} onChange={(e) => set("media", { url: e.target.value })} />
              </label>
              <label>
                {s.media.type === "plex" ? "Plex token" : "API key"} <input value={s.media.token} onChange={(e) => set("media", { token: e.target.value })} />
              </label>
            </>
          )}
          {s.media.type === "jellyfin" && users && (
            <label>
              User
              <select value={s.media.userId} onChange={(e) => set("media", { userId: e.target.value })}>
                <option value="">Choose…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {s.media.type !== "none" && (
          <button className="ghost" onClick={testMedia}>
            Test
          </button>
        )}
        {msg.media && <span className="note">{msg.media}</span>}
        {libs && (
          <div className="libs">
            <span className="muted small">Anime libraries (none ticked = all):</span>
            {libs.map((l) => (
              <label key={l.id} className="check">
                <input
                  type="checkbox"
                  checked={s.media.libraryIds.includes(l.id)}
                  onChange={(e) => set("media", { libraryIds: e.target.checked ? [...s.media.libraryIds, l.id] : s.media.libraryIds.filter((x) => x !== l.id) })}
                />{" "}
                {l.title}
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="card pad">
        <h2>Alerts</h2>
        <p className="muted small">
          For phone alerts install the free <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> app, subscribe to a topic name only you know, and paste its URL here.
        </p>
        <div className="form">
          <label>
            ntfy topic URL <input value={s.notify.ntfyUrl} placeholder="https://ntfy.sh/my-secret-anime-topic" onChange={(e) => set("notify", { ntfyUrl: e.target.value })} />
          </label>
          <label>
            ntfy token (optional) <input value={s.notify.ntfyToken} onChange={(e) => set("notify", { ntfyToken: e.target.value })} />
          </label>
          <label>
            Gotify URL <input value={s.notify.gotifyUrl} onChange={(e) => set("notify", { gotifyUrl: e.target.value })} />
          </label>
          <label>
            Gotify app token <input value={s.notify.gotifyToken} onChange={(e) => set("notify", { gotifyToken: e.target.value })} />
          </label>
          <label>
            Discord webhook <input value={s.notify.discordWebhook} onChange={(e) => set("notify", { discordWebhook: e.target.value })} />
          </label>
          <label>
            Shows in the new-season alert <input type="number" min={3} max={30} value={s.notify.picks} onChange={(e) => set("notify", { picks: Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={s.notify.seasonAlerts} onChange={(e) => set("notify", { seasonAlerts: e.target.checked })} /> Alert me when next season's picks are ready
          </label>
          <label className="check">
            <input type="checkbox" checked={s.notify.episodeAlerts} onChange={(e) => set("notify", { episodeAlerts: e.target.checked })} /> Alert me when a new episode is downloaded
          </label>
          <label>
            Address your phone can reach Tastearr at (optional, for the "Not into it" button)
            <input value={s.externalUrl} placeholder="https://tastearr.example.com" onChange={(e) => set("externalUrl", e.target.value as never)} />
          </label>
        </div>
        <button className="ghost" onClick={() => run("notify", async () => (await save(true), `✓ Sent to ${(await api<{ sent: string[] }>("/test/notify", { body: {} })).sent.join(", ") || "nothing configured"}`))}>
          Send test alert
        </button>
        {msg.notify && <span className="note">{msg.notify}</span>}
        <p className="muted small">
          New-episode alerts: in Sonarr go to Settings → Connect → + → Webhook, tick "On Import", and use this URL:
        </p>
        <code className="copy" onClick={() => navigator.clipboard?.writeText(webhook)} title="Click to copy">
          {webhook}
        </code>
      </div>

      <div className="card pad">
        <h2>Filters</h2>
        <div className="form">
          <label>
            Never show these genres <input value={csv(s.filters.excludeGenres)} placeholder="Slice of Life, Music" onChange={(e) => set("filters", { excludeGenres: uncsv(e.target.value) })} />
          </label>
          <label>
            Never show these tags <input value={csv(s.filters.excludeTags)} placeholder="Kids, Idol" onChange={(e) => set("filters", { excludeTags: uncsv(e.target.value) })} />
          </label>
          <label>
            Seasons to learn from <input type="number" min={2} max={20} value={s.training.seasons} onChange={(e) => set("training", { seasons: Number(e.target.value) })} />
          </label>
          <label>
            Formats <input value={csv(s.training.formats)} onChange={(e) => set("training", { formats: uncsv(e.target.value) })} />
          </label>
        </div>
      </div>

      <div className="card pad">
        <h2>Security</h2>
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={s.auth.enabled} onChange={(e) => set("auth", { enabled: e.target.checked })} /> Require login
          </label>
          {s.auth.enabled && (
            <>
              <label>
                Username <input value={s.auth.username} autoComplete="username" onChange={(e) => set("auth", { username: e.target.value })} />
              </label>
              <label>
                {s.auth.passwordHash ? "New password (leave blank to keep)" : "Password"}
                <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={s.auth.bypassLocal} onChange={(e) => set("auth", { bypassLocal: e.target.checked })} /> No login needed on my local network
              </label>
            </>
          )}
          <label>
            API key
            <span className="row">
              <code>{s.apiKey}</code>
              <button className="ghost small" onClick={async () => setS({ ...s, apiKey: (await api<{ apiKey: string }>("/settings/apikey", { body: {} })).apiKey })}>
                Regenerate
              </button>
            </span>
          </label>
        </div>
      </div>
    </section>
  );
}
