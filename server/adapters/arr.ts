import { fail } from "../core/errors.js";
import { safeFetch } from "./net.js";

/** Shared HTTP client for the Sonarr and Radarr v3 APIs. */

/** Address and API key of one Sonarr or Radarr. */
export interface ArrConn {
  url: string;
  apiKey: string;
}

export type ArrApp = "Sonarr" | "Radarr";

/** A non-2xx answer; `body` is kept so callers can tell "already added" from other refusals. */
export class ArrError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
  }
}

export async function arrRequest<T>(app: ArrApp, conn: ArrConn, method: string, path: string, body?: unknown): Promise<T> {
  if (!conn.url || !conn.apiKey) throw fail(`${app} is not configured`, 400);
  const res = await safeFetch(
    `${conn.url}/api/v3${path}`,
    {
      method,
      headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    },
    `The ${app} address`,
  );
  if (!res.ok) {
    // The body only helps tell refusals apart; if it can't be read, the status alone still reports the failure.
    const detail = await res.text().catch(() => "");
    throw new ArrError(`${app} ${method} ${path.split("?")[0]} failed (HTTP ${res.status})`, res.status, detail);
  }
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    // Usually a reverse proxy's login or error page answering instead of the API.
    throw new Error(`${app} ${method} ${path.split("?")[0]} answered with something that isn't JSON; check the address in Settings`);
  }
}

/** Version check that also catches pointing Sonarr's settings at Radarr (and vice versa). */
export async function arrStatus(app: ArrApp, conn: ArrConn) {
  const s = await arrRequest<{ version: string; appName?: string }>(app, conn, "GET", "/system/status");
  if (s.appName && s.appName !== app) throw fail(`That's ${s.appName}, not ${app}`, 400);
  return { version: s.version };
}

/** Quality profiles, root folders and tags, for the settings form. */
export async function arrOptions(app: ArrApp, conn: ArrConn) {
  const [profiles, roots, tags] = await Promise.all([
    arrRequest<{ id: number; name: string }[]>(app, conn, "GET", "/qualityprofile"),
    arrRequest<{ id: number; path: string }[]>(app, conn, "GET", "/rootfolder"),
    arrRequest<{ id: number; label: string }[]>(app, conn, "GET", "/tag"),
  ]);
  return { profiles: profiles.map(({ id, name }) => ({ id, name })), roots: roots.map(({ id, path }) => ({ id, path })), tags };
}

export function arrTags(app: ArrApp, conn: ArrConn) {
  return arrRequest<{ id: number; label: string }[]>(app, conn, "GET", "/tag");
}

/**
 * The id of the "tastearr" tag, created if missing. Two adds at once can both try to create it: when creating fails,
 * the tags are read again in case the other one made it. Throws when tags can't be read or created.
 */
export async function tastearrTag(app: ArrApp, conn: ArrConn): Promise<number> {
  const find = async () => (await arrTags(app, conn)).find((t) => t.label.toLowerCase() === "tastearr");
  const have = await find();
  if (have) return have.id;
  try {
    return (await arrRequest<{ id: number }>(app, conn, "POST", "/tag", { label: "tastearr" })).id;
  } catch (e) {
    const made = await find();
    if (made) return made.id;
    throw e;
  }
}
