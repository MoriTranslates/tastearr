import { useEffect, useState } from "react";
import { api, store, type Settings as S, type Status } from "../api";
import { Link } from "../App";
import { AlertsCard, ArrCard, AutoDetect, ListsCard, MediaCard, useSettings } from "../connections";
import { ListInput, NumberInput, SecretInput, usePageTitle, useToast } from "../ui";

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
  const [tab, setTab] = useState<Tab>(() => store.get("settingsTab", "connections"));
  useEffect(() => store.set("settingsTab", tab), [tab]);

  const saveAndNotify = async (patch: Partial<S>) => {
    const r = await save(patch);
    onSaved();
    return r;
  };

  if (error) return <p className="error">{error}</p>;
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

      {tab === "connections" && (
        <>
          <AutoDetect onUsed={() => api<S>("/settings").then(setS)} />
          <ArrCard kind="sonarr" s={s} save={saveAndNotify} />
          <ArrCard kind="radarr" s={s} save={saveAndNotify} />
          <MediaCard s={s} save={saveAndNotify} />
          <ListsCard s={s} save={saveAndNotify} />
        </>
      )}
      {tab === "picks" && <PicksSettings s={s} save={saveAndNotify} />}
      {tab === "alerts" && <AlertsCard s={s} save={saveAndNotify} />}
      {tab === "security" && <Security s={s} status={status} save={saveAndNotify} />}
    </section>
  );
}

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
      await api("/profile/rebuild", { body: {} });
      toast("Saved. Rebuilding your taste profile…");
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
          <select value={display.titleLanguage} onChange={(e) => setDisplay({ titleLanguage: e.target.value as S["display"]["titleLanguage"] })}>
            <option value="english">English</option>
            <option value="romaji">Romaji</option>
            <option value="native">Native (日本語)</option>
          </select>
        </label>
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
          <input type="checkbox" checked={filters.hideInLibrary} onChange={(e) => setFilters({ ...filters, hideInLibrary: e.target.checked })} /> Hide shows already in my library by default
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hideShorts} onChange={(e) => setFilters({ ...filters, hideShorts: e.target.checked })} /> Hide the Shorts section by default
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
      await save({ auth: { ...s.auth, bypassLocal: bypass } });
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
  async function logout() {
    await api("/auth/logout", { body: {} }).catch(() => undefined);
    location.href = "/";
  }

  return (
    <>
      <div className="card pad stack">
        <h2>Authentication</h2>
        <div className="form">
          <label>
            Authentication required
            <select value={bypass ? "local" : "enabled"} onChange={(e) => setBypass(e.target.value === "local")}>
              <option value="enabled">Enabled</option>
              <option value="local">Disabled for local addresses</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          "Disabled for local addresses" skips the login for devices on your home network. Requests through a reverse proxy or tunnel always need the login, unless you set{" "}
          <code>TRUST_PROXY</code> to your proxy's address.
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
              <SecretInput label="API key" value={keys.apiKey} onChange={() => undefined} />
            ) : (
              <span className="muted small">Log in with your password to see it (hidden when using the local-network bypass).</span>
            )}
          </label>
          <label className="wide">
            Webhook key (only works for Sonarr/Radarr webhooks)
            <code className="trunc">{keys?.webhookKey ?? s.webhookKey}</code>
          </label>
        </div>
        <div className="row end">
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
