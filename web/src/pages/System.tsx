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

  if (!info) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h1>System</h1>
      <div className="card pad">
        <p>
          Tastearr v{info.version} · Node {info.node} · up {relTime(Date.now() - info.uptime).replace(" ago", "")}
        </p>
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
