import { useEffect, useState } from "react";
import { api, type Settings as S, type Status } from "../api";
import { SecretInput, useToast } from "../components/ui";
import { errorMessage } from "../lib/errors";

export function Security({ s, status }: { s: S; status: Status }) {
  const toast = useToast();
  const [bypass, setBypass] = useState(s.auth.bypassLocal);
  const [acct, setAcct] = useState({ currentPassword: "", username: s.auth.username, password: "" });
  const [keys, setKeys] = useState<{ apiKey: string | null; webhookKey: string } | null>(null);

  useEffect(() => {
    api<{ apiKey: string | null; webhookKey: string }>("/settings/keys")
      .then(setKeys)
      .catch(() => undefined);
  }, []);

  async function saveMode() {
    try {
      await api("/auth/mode", { method: "PUT", body: { bypassLocal: bypass } });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }
  async function saveAccount() {
    try {
      await api("/auth/account", { method: "PUT", body: acct });
      setAcct({ ...acct, currentPassword: "", password: "" });
      toast("Account updated");
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }
  async function regen(which: "apiKey" | "webhookKey") {
    const what = which === "apiKey" ? "API key" : "webhook key";
    if (
      !confirm(
        `Make a new ${what}? Anything using the old one ${which === "webhookKey" ? "(your Sonarr/Radarr webhooks)" : ""} will stop working until you update it.`,
      )
    )
      return;
    try {
      const r = await api<Record<string, string>>(`/settings/keys/${which}/regenerate`, { body: {} });
      setKeys((k) => (k ? { ...k, ...r } : k));
      toast(`New ${what} created`);
    } catch (e) {
      toast(errorMessage(e), true);
    }
  }
  async function resetMatches() {
    if (!confirm("Forget every show you matched to Sonarr by hand? The community list applies again.")) return;
    try {
      const r = await api<{ cleared: number }>("/mapping/reset", { body: {} });
      toast(`Forgot ${r.cleared} match${r.cleared === 1 ? "" : "es"}`);
    } catch (e) {
      toast(errorMessage(e), true);
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
          Same as Sonarr's "Authentication Required: Disabled for Local Addresses". Visits through a reverse proxy or tunnel always need the
          password unless you set <code>TRUST_PROXY</code> to your proxy's address. Changing this needs a password login, not the
          home-network shortcut.
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
            <input
              type="password"
              value={acct.password}
              autoComplete="new-password"
              onChange={(e) => setAcct({ ...acct, password: e.target.value })}
            />
          </label>
          <label>
            Current password
            <input
              type="password"
              value={acct.currentPassword}
              autoComplete="current-password"
              onChange={(e) => setAcct({ ...acct, currentPassword: e.target.value })}
            />
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
            In Sonarr: Settings → Import Lists → + → Custom List, and paste the first address. In Radarr: Settings → Lists → + → Custom
            List, and paste the second. They list shows you gave 👍 on the Picks page.
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
            Recommended Sonarr list settings: Series Type <em>Anime</em>, Monitor <em>Last Season</em>, Search on add off, tag{" "}
            <em>tastearr</em>, and leave "Clean Library Level" disabled. Only 👍 from the last 4 months are listed; quiz answers never are.
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
