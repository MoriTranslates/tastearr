import { useState } from "react";
import { api } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/auth/login", { body: { username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="login card" onSubmit={submit}>
      <img src="/favicon.svg" alt="" width={48} height={48} />
      <h1>Tastearr</h1>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary">Log in</button>
    </form>
  );
}
