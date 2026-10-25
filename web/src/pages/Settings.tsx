import { useEffect, useState } from "react";
import { api, store, type Settings as S, type Status } from "../api";
import { Link } from "../App";
import { AlertsCard, ArrCard, AutoDetect, ExtraSonarrCard, ListsCard, MediaCard, useSettings } from "../connections";
import { ErrorBox, ListInput, NumberInput, SecretInput, usePageTitle, useToast } from "../ui";

const TABS = [
  { id: "connections", label: "Connections" },
  { id: "picks", label: "Picks & filters" },
  { id: "alerts", label: "Alerts" },
  { id: "security", label: "Security" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function Settings({ status, onSaved }: { status: Status; onSaved: () => void }) {
  usePageTitle("Settings");
  const { s, setS, save, error } = useSettings();
  // Streaming-only users start on Picks & filters; server users on Connections. A tab they pick is remembered.
  const [tab, setTabRaw] = useState<Tab>(() => store.get<Tab | null>("settingsTab", null) ?? (status.mode === "stream" ? "picks" : "connections"));
  const setTab = (t: Tab) => (setTabRaw(t), store.set("settingsTab", t));

  // Decided once per visit, so saving Sonarr inside the folded section doesn't reshuffle the page.
  const [streamLayout] = useState(status.mode === "stream" && !status.sonarr && !status.radarr && !status.media);
  const saveAndNotify = async (patch: Partial<S>) => {
    const r = await save(patch);
    onSaved();
    return r;
  };

  if (error) return <ErrorBox error={error} retry={() => location.reload()} />;
  if (!s) return <p className="muted">Loading settings…</p>;

  return (
    <section className="settings">
      <div className="toolbar">
        <h1>Settings</h1>
        <Link to="/setup" className="button ghost small">
          Setup guide
        </Link>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "connections" &&
        (streamLayout ? (
          <>
            <ListsCard s={s} save={saveAndNotify} />
            <details className="card pad">
              <summary>Media server apps (optional: Sonarr, Radarr, Plex, Jellyfin)</summary>
              <ServerCards s={s} setS={setS} save={saveAndNotify} />
            </details>
          </>
        ) : (
          <>
            <ServerCards s={s} setS={setS} save={saveAndNotify} />
            <ListsCard s={s} save={saveAndNotify} />
          </>
        ))}
      {tab === "picks" && <PicksSettings s={s} save={saveAndNotify} />}
      {tab === "alerts" && <AlertsCard s={s} save={saveAndNotify} />}
      {tab === "security" && <Security s={s} status={status} save={saveAndNotify} />}
    </section>
  );
}

function ServerCards({ s, setS, save }: { s: S; setS: (s: S) => void; save: (p: Partial<S>) => Promise<S> }) {
  // Cards remount after "Find my apps" fills in an address, so they show (and keep) what was detected.
  const [gen, setGen] = useState(0);
  return (
    <>
      <AutoDetect onUsed={() => api<S>("/settings").then((x) => (setS(x), setGen((g) => g + 1)))} />
      <ArrCard key={`sonarr-${gen}`} kind="sonarr" s={s} save={save} />
      <ExtraSonarrCard s={s} onChange={() => api<S>("/settings").then(setS)} />
      <ArrCard key={`radarr-${gen}`} kind="radarr" s={s} save={save} />
      <MediaCard s={s} save={save} />
    </>
  );
}

/** Common legal streaming sites (AniList's names), for "my services". */
const SERVICES = ["Crunchyroll", "Netflix", "HIDIVE", "Prime Video", "Disney+", "Hulu", "Max", "Bilibili TV", "YouTube", "Muse Asia", "Ani-One Asia", "iQIYI", "Tubi", "Hoopla", "Laftel"];

function PicksSettings({ s, save }: { s: S; save: (p: Partial<S>) => Promise<S> }) {
  const toast = useToast();
  const [filters, setFilters] = useState(s.filters);
  const [training, setTraining] = useState(s.training);
  const [display, setDisplay] = useState(s.display);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await save({ filters, training, display });
      // New defaults should show up on Picks, so forget the filters set there earlier.
      if (JSON.stringify(display.services) !== JSON.stringify(s.display.services)) store.set("services", null);
      if (filters.hideInLibrary !== s.filters.hideInLibrary) store.set("showLibrary", null);
      if (filters.hideShorts !== s.filters.hideShorts) store.set("collapsed", null);
      if (JSON.stringify(training) !== JSON.stringify(s.training)) {
        await api("/profile/rebuild", { body: {} });
        toast("Saved. Re-learning your taste (takes a minute)…");
      } else toast("Saved");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card pad stack">
      <h2>Picks & filters</h2>
      <div className="form">
        <label>
          Titles in
          <select value={display.titleLanguage} onChange={(e) => setDisplay({ ...display, titleLanguage: e.target.value as S["display"]["titleLanguage"] })}>
            <option value="english">English</option>
            <option value="romaji">Romaji</option>
            <option value="native">Native (日本語)</option>
          </select>
        </label>
        <div className="wide">
          <span>My streaming services</span>
          <div className="chips" role="group" aria-label="My streaming services">
            {[...new Set([...SERVICES, ...display.services])].map((sv) => {
              const on = display.services.includes(sv);
              return (
                <button key={sv} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={() => setDisplay({ ...display, services: on ? display.services.filter((x) => x !== sv) : [...display.services, sv] })}>
                  {on ? "✓ " : ""}
                  {sv}
                </button>
              );
            })}
          </div>
          <span className="muted small">Picks and the Schedule start filtered to these. Leave empty to see everything.</span>
        </div>
        <label>
          Never show these genres
          <ListInput label="Excluded genres" value={filters.excludeGenres} placeholder="Slice of Life, Music" onChange={(v) => setFilters({ ...filters, excludeGenres: v })} />
        </label>
        <label>
          Never show these tags
          <ListInput label="Excluded tags" value={filters.excludeTags} placeholder="Kids, Idol" onChange={(v) => setFilters({ ...filters, excludeTags: v })} />
        </label>
        <label>
          Seasons to learn from
          <NumberInput label="Seasons" min={2} max={24} value={training.seasons} onChange={(v) => setTraining({ ...training, seasons: v })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.noGore} onChange={(e) => setFilters({ ...filters, noGore: e.target.checked })} /> Hide shows with gore or graphic violence
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hideInLibrary} onChange={(e) => setFilters({ ...filters, hideInLibrary: e.target.checked })} /> Hide shows I already have, by default
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hideShorts} onChange={(e) => setFilters({ ...filters, hideShorts: e.target.checked })} /> Fold away the Shorts section by default
        </label>
      </div>
      <p className="muted small">Filters never hide sequels of shows you watch. Your quiz genre answers live on the Quiz page.</p>
      <div className="row end">
        <Link to="/quiz" className="button ghost">
          Retake quiz
        </Link>
        <button className="primary" disabled={busy} onClick={submit}>
          Save
        </button>
      </div>
    </div>
  );
}

function Security({ s, status, save }: { s: S; status: Status; save: (p: Partial<S>) => Promise<S> }) {
  const toast = useToast();
  const [bypass, setBypass] = useState(s.auth.bypassLocal);
  const [acct, setAcct] = useState({ currentPassword: "", username: s.auth.username, password: "" });
  const [keys, setKeys] = useState<{ apiKey: string | null; webhookKey: string } | null>(null);

  useEffect(() => {
    api<{ apiKey: string | null; webhookKey: string }>("/settings/keys").then(setKeys).catch(() => undefined);
  }, []);

  async function saveMode() {
    try {
      await api("/auth/mode", { method: "PUT", body: { bypassLocal: bypass } });
      toast("Saved");
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function saveAccount() {
    try {
      await api("/auth/account", { method: "PUT", body: acct });
      setAcct({ ...acct, currentPassword: "", password: "" });
      toast("Account updated");
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function regen(which: "apiKey" | "webhookKey") {
    const what = which === "apiKey" ? "API key" : "webhook key";
    if (!confirm(`Make a new ${what}? Anything using the old one ${which === "webhookKey" ? "(your Sonarr/Radarr webhooks)" : ""} will stop working until you update it.`)) return;
    try {
      const r = await api<Record<string, string>>(`/settings/keys/${which}/regenerate`, { body: {} });
      setKeys((k) => (k ? { ...k, ...r } : k));
      toast(`New ${what} created`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function resetMatches() {
    if (!confirm("Forget every show you matched to Sonarr by hand? The community list applies again.")) return;
    try {
      const r = await api<{ cleared: number }>("/mapping/reset", { body: {} });
      toast(`Forgot ${r.cleared} match${r.cleared === 1 ? "" : "es"}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function logout() {
    await api("/auth/logout", { body: {} }).catch(() => undefined);
    location.href = "/";
  }

  return (
    <>
      <div className="card pad stack">
        <h2>Login</h2>
        <div className="form">
          <label>
            Ask for the password
            <select value={bypass ? "local" : "enabled"} onChange={(e) => setBypass(e.target.value === "local")}>
              <option value="enabled">Always</option>
              <option value="local">Not when I'm on my home network</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          Same as Sonarr's "Authentication Required: Disabled for Local Addresses". Visits through a reverse proxy or tunnel always need the password unless you set{" "}
          <code>TRUST_PROXY</code> to your proxy's address. Changing this needs a password login, not the home-network shortcut.
        </p>
        <div className="row end">
          <button className="primary" onClick={saveMode}>
            Save
          </button>
        </div>
      </div>

      <div className="card pad stack">
        <h2>Account</h2>
        <div className="form">
          <label>
            Username
            <input value={acct.username} autoComplete="username" onChange={(e) => setAcct({ ...acct, username: e.target.value })} />
          </label>
          <label>
            New password (leave blank to keep)
            <input type="password" value={acct.password} autoComplete="new-password" onChange={(e) => setAcct({ ...acct, password: e.target.value })} />
          </label>
          <label>
            Current password
            <input type="password" value={acct.currentPassword} autoComplete="current-password" onChange={(e) => setAcct({ ...acct, currentPassword: e.target.value })} />
          </label>
        </div>
        <div className="row end">
          {status.via === "session" && (
            <button className="ghost" onClick={logout}>
              Log out
            </button>
          )}
          <button className="primary" disabled={!acct.currentPassword} onClick={saveAccount}>
            Update account
          </button>
        </div>
      </div>

      <div className="card pad stack">
        <h2>Keys</h2>
        <div className="form">
          <label className="wide">
            API key (X-Api-Key header, full access)
            {keys?.apiKey ? (
              <span className="row">
                <SecretInput label="API key" value={keys.apiKey} onChange={() => undefined} readOnly />
                <button className="ghost small" onClick={() => navigator.clipboard?.writeText(keys.apiKey!).then(() => toast("Copied"))}>
                  Copy
                </button>
              </span>
            ) : (
              <span className="muted small">Log in with your password to see it (hidden when using the local-network bypass).</span>
            )}
          </label>
          <label className="wide">
            Webhook key (only works for Sonarr/Radarr webhooks and import lists)
            <code className="trunc">{keys?.webhookKey ?? s.webhookKey}</code>
          </label>
        </div>
        <details>
          <summary>Import lists (let Sonarr/Radarr pull your 👍 picks instead)</summary>
          <p className="muted small">
            In Sonarr: Settings → Import Lists → + → Custom List, and paste the first address. In Radarr: Settings → Lists → + → Custom List, and paste the second. They list
            shows you gave 👍 on the Picks page.
          </p>
          {(["sonarr", "radarr"] as const).map((app) => {
            const url = `${s.externalUrl || location.origin}/api/importlist/${app}/${keys?.webhookKey ?? s.webhookKey}`;
            return (
              <p key={app} className="row">
                <span className="mono">{url}</span>
                <button className="ghost small" onClick={() => navigator.clipboard?.writeText(url).then(() => toast("Copied"))}>
                  Copy
                </button>
              </p>
            );
          })}
          <p className="muted small">
            Recommended Sonarr list settings: Series Type <em>Anime</em>, Monitor <em>Last Season</em>, Search on add off, tag <em>tastearr</em>, and leave "Clean Library
            Level" disabled. Only 👍 from the last 4 months are listed; quiz answers never are.
          </p>
        </details>
        <div className="row end">
          <button className="ghost" onClick={resetMatches}>
            Reset show matches
          </button>
          <button className="ghost" onClick={() => regen("webhookKey")}>
            New webhook key
          </button>
          {keys?.apiKey && (
            <button className="ghost" onClick={() => regen("apiKey")}>
              New API key
            </button>
          )}
        </div>
      </div>
    </>
  );
}
