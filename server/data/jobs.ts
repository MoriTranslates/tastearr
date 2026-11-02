import type { Job } from "../../shared/api.js";
import { db } from "./db.js";

/**
 * Background job status (System -> Tasks): one row per job with the latest run, plus the last success and the last
 * failure kept separately, so a run that succeeds after a failure doesn't erase when and why it failed.
 */

export interface JobHistory {
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
}

export function setJob(name: string, state: "running" | "done" | "error", detail = "") {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (name, state, detail, started_at, finished_at, last_error, last_error_at, last_success_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET state = excluded.state, detail = excluded.detail,
       started_at = CASE WHEN excluded.state = 'running' AND jobs.state != 'running' THEN excluded.started_at ELSE jobs.started_at END,
       finished_at = excluded.finished_at,
       last_error = COALESCE(excluded.last_error, jobs.last_error),
       last_error_at = COALESCE(excluded.last_error_at, jobs.last_error_at),
       last_success_at = COALESCE(excluded.last_success_at, jobs.last_success_at)`,
  ).run(
    name,
    state,
    detail,
    now,
    state === "running" ? null : now,
    state === "error" ? detail : null,
    state === "error" ? now : null,
    state === "done" ? now : null,
  );
}

/**
 * Records a problem in a run that still finished (a season AniList couldn't send, a list that failed to import) as the
 * job's last error, without changing its current state.
 */
export function noteJobError(name: string, message: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO jobs (name, state, detail, started_at, finished_at, last_error, last_error_at) VALUES (?, 'done', '', ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
  ).run(name, now, now, message, now);
}

export function listJobs(): (Job & JobHistory)[] {
  return db
    .prepare(
      `SELECT name, state, detail, started_at AS startedAt, finished_at AS finishedAt, last_error AS lastError,
         last_error_at AS lastErrorAt, last_success_at AS lastSuccessAt FROM jobs ORDER BY name`,
    )
    .all() as unknown as (Job & JobHistory)[];
}
