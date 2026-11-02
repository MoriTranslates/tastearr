import { checkOutbound } from "../core/outbound.js";

/** Shared HTTP client for the Sonarr and Radarr v3 APIs. */

/** Address and API key of one Sonarr or Radarr. */
export interface ArrConn {
  url: string;
  apiKey: string;
}

export type ArrApp = "Sonarr" | "Radarr";

export async function arrRequest<T>(app: ArrApp, conn: ArrConn, method: string, path: string, body?: unknown): Promise<T> {
  if (!conn.url || !conn.apiKey) throw new Error(`${app} is not configured`);
  checkOutbound(conn.url, `The ${app} address`);
  const res = await fetch(`${conn.url}/api/v3${path}`, {
    method,
    headers: { "X-Api-Key": conn.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${app} ${method} ${path.split("?")[0]} failed (HTTP ${res.status})`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Version check that also catches pointing Sonarr's settings at Radarr (and vice versa). */
export async function arrStatus(app: ArrApp, conn: ArrConn) {
  const s = await arrRequest<{ version: string; appName?: string }>(app, conn, "GET", "/system/status");
  if (s.appName && s.appName !== app) throw new Error(`That's ${s.appName}, not ${app}`);
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

/** The id of the "tastearr" tag, created if missing. Throws when tags can't be read or created. */
export async function tastearrTag(app: ArrApp, conn: ArrConn): Promise<number> {
  const tags = await arrTags(app, conn);
  return (tags.find((t) => t.label === "tastearr") ?? (await arrRequest<{ id: number }>(app, conn, "POST", "/tag", { label: "tastearr" })))
    .id;
}
