import { useState } from "react";
import { api } from "../api";
import { usePageTitle } from "../ui";

/** First run: create the admin account, like Sonarr/Radarr's "Authentication Required" screen. */
export function Setup({ onDone }: { onDone: () => void }) {
  usePageTitle("Welcome");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"enabled" | "local">("local");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api("/auth/setup", { body: { username, password, bypassLocal: mode === "local" } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login card" onSubmit={submit}>
      <img src="/favicon.svg" alt="" width={48} height={48} />
      <h1>Welcome to Tastearr</h1>
      <p className="muted small">Create the account that protects this Tastearr. It holds your Sonarr, Radarr and media server keys.</p>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
      </label>
      <label>
        Password (8+ characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      <label>
        Confirm password
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </label>
      <label>
        Authentication required
        <select value={mode} onChange={(e) => setMode(e.target.value as "enabled" | "local")}>
          <option value="local">Disabled for local addresses</option>
          <option value="enabled">Enabled</option>
        </select>
      </label>
      <p className="muted small left">
        "Disabled for local addresses" skips the login on your home network, like Sonarr. It's switched off automatically for requests that come
        through a reverse proxy or tunnel, so exposing Tastearr online still needs the password.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        Create account
      </button>
    </form>
  );
}
