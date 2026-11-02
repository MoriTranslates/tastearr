import type { Job } from "../../shared/api.js";
import { db } from "./db.js";

/** Background job status (System -> Tasks): one row per job, the latest run. */

export function setJob(name: string, state: "running" | "done" | "error", detail = "") {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (name, state, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET state = excluded.state, detail = excluded.detail,
       started_at = CASE WHEN excluded.state = 'running' AND jobs.state != 'running' THEN excluded.started_at ELSE jobs.started_at END,
       finished_at = excluded.finished_at`,
  ).run(name, state, detail, now, state === "running" ? null : now);
}

export function listJobs() {
  return db
    .prepare("SELECT name, state, detail, started_at AS startedAt, finished_at AS finishedAt FROM jobs ORDER BY name")
    .all() as unknown as Job[];
}
