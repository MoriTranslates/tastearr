import { useState } from "react";
import { api } from "../api";
import { useToast } from "../components/ui";
import { usePageTitle } from "../hooks/usePageTitle";
import { relTime } from "../lib/format";
import { useHealth, useSystemInfo } from "./useSystem";
import { errorMessage } from "../lib/errors";

const JOB_NAMES: Record<string, string> = { profile: "Build taste profile", refresh: "Refresh seasons & alerts" };

export function System() {
  usePageTitle("System");
  const toast = useToast();
  const info = useSystemInfo();

  const { health, checkHealth } = useHealth();

  // The backup holds every key, so it asks for the password again (and needs a password login, not the home-network shortcut).
  const [pw, setPw] = useState("");
  const [saving, setSaving] = useState(false);
  async function backup(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/system/backup", {
        method: "POST",
        headers: { "X-Tastearr": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `tastearr-backup-${new Date().toISOString().slice(0, 10)}.db`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setPw("");
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setSaving(false);
    }
  }

  if (!info) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h1>System</h1>
      <div className="card pad">
        <p>
          Tastearr v{info.version} · Node {info.node} · up {relTime(Date.now() - info.uptime).replace(" ago", "")}
        </p>
      </div>
      <div className="card pad stack">
        <div className="card-head">
          <h2>Health</h2>
          <button className="ghost small" onClick={checkHealth}>
            Check again
          </button>
        </div>
        {!health && <p className="muted small">Checking connections…</p>}
        {health && (
          <ul className="health">
            {health.checks.map((c, i) => (
              <li key={i}>
                <span aria-hidden="true">{c.ok ? "✓" : "⚠"}</span>
                <strong>{c.name}</strong>
                <span className={c.ok ? "muted small" : "small error"}>
                  {c.ok ? "" : "Problem: "}
                  {c.detail}
                </span>
              </li>
            ))}
            {!health.checks.length && <li className="muted small">Nothing connected yet.</li>}
          </ul>
        )}
      </div>
      <div className="card pad stack">
        <h2>Backup</h2>
        <p className="muted small">
          Downloads Tastearr's database: settings, keys, your ratings and taste data. Keep it private; it holds your API keys. To restore,
          stop the container and put the file in your config folder as <code>tastearr.db</code>.
        </p>
        <form className="row" onSubmit={backup}>
          <input
            type="password"
            aria-label="Your password"
            placeholder="Your password"
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <button className="ghost" disabled={!pw || saving}>
            {saving ? "Preparing…" : "Download backup"}
          </button>
        </form>
      </div>
      <div className="card pad">
        <h2>Tasks</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {info.jobs.map((j) => (
              <tr key={j.name}>
                <td>{JOB_NAMES[j.name] ?? j.name}</td>
                <td className={j.state === "error" ? "error" : ""}>
                  {j.state === "running" ? "⏳ " : j.state === "error" ? "⚠ " : "✓ "}
                  {j.detail}
                </td>
                <td>{j.finishedAt ? relTime(j.finishedAt) : j.startedAt ? `started ${relTime(j.startedAt)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="ghost"
          onClick={() =>
            api("/profile/rebuild", { body: {} })
              .then(() => toast("Rebuilding your taste profile"))
              .catch((e) => toast(errorMessage(e), true))
          }
        >
          Rebuild taste profile now
        </button>
      </div>
    </section>
  );
}
