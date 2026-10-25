import { useEffect, useState } from "react";
import { api, type Job } from "../api";
import { relTime, usePageTitle, useToast } from "../ui";

const JOB_NAMES: Record<string, string> = { profile: "Build taste profile", refresh: "Refresh seasons & alerts" };

export function System() {
  usePageTitle("System");
  const toast = useToast();
  const [info, setInfo] = useState<{ version: string; uptime: number; node: string; jobs: Job[] } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api<{ version: string; uptime: number; node: string; jobs: Job[] }>("/system").then((x) => alive && setInfo(x)).catch((e) => toast(e.message, true));
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [toast]);

  const [health, setHealth] = useState<{ checks: { name: string; ok: boolean; detail: string }[]; webhooks: Record<string, number> } | null>(null);
  const checkHealth = () => {
    setHealth(null);
    api<NonNullable<typeof health>>("/system/health").then(setHealth).catch((e) => toast(e.message, true));
  };
  useEffect(checkHealth, [toast]);

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
            {Object.entries(health.webhooks).map(([k, at]) => (
              <li key={k}>
                <span aria-hidden="true">✓</span>
                <strong>{k === "sonarr" ? "Sonarr" : "Radarr"} webhook</strong>
                <span className="muted small">last heard from {relTime(at)}</span>
              </li>
            ))}
            {!health.checks.length && <li className="muted small">Nothing connected yet.</li>}
          </ul>
        )}
      </div>
      <div className="card pad stack">
        <h2>Backup</h2>
        <p className="muted small">
          Downloads Tastearr's database: settings, keys, your ratings and taste data. Keep it private; it holds your API keys. To restore, stop the container and put the file in your
          config folder as <code>tastearr.db</code>.
        </p>
        <a className="button ghost" href="/api/system/backup" download>
          Download backup
        </a>
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
              .catch((e) => toast(e.message, true))
          }
        >
          Rebuild taste profile now
        </button>
      </div>
    </section>
  );
}
