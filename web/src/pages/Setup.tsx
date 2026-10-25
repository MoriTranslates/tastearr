import { useState } from "react";
import { api, ApiError } from "../api";
import { usePageTitle } from "../ui";

/** First run: create the account (like Sonarr/Radarr's "Authentication Required" screen, in plain words). */
export function Setup({ onDone }: { onDone: () => void }) {
  usePageTitle("Welcome");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mode, setMode] = useState<"enabled" | "local">("enabled");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api("/auth/setup", { body: { username, password, bypassLocal: mode === "local", setupToken: code || undefined } });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setNeedCode(true);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login card" onSubmit={submit}>
      <img src="/favicon.svg" alt="" width={48} height={48} />
      <h1>Welcome to Tastearr</h1>
      <p className="muted small">Pick a username and password. They keep your settings private.</p>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
      </label>
      <label>
        Password (at least 8 characters)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
      </label>
      <label>
        Type it again
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </label>
      <label>
        Ask for the password
        <select value={mode} onChange={(e) => setMode(e.target.value as "enabled" | "local")}>
          <option value="enabled">Always</option>
          <option value="local">Not when I'm on my home network</option>
        </select>
      </label>
      {mode === "local" && (
        <p className="muted small left">
          Devices on your home Wi-Fi skip the login. If Tastearr is ever opened from outside your home, it still asks for the password. (Sonarr calls this
          "Disabled for local addresses".)
        </p>
      )}
      {needCode && (
        <label>
          Setup code (shown in Tastearr's log)
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        </label>
      )}
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
