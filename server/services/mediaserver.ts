import { jellyfinInfo, jellyfinLibraries, jellyfinUsers, jellyfinWatchStates } from "../adapters/jellyfin.js";
import { plexCheckPin, plexCreatePin, plexInfo, plexLibraries, plexServers, plexWatchStates } from "../adapters/plex.js";
import { fail } from "../core/errors.js";
import type { Settings } from "../core/settings.js";
import type { WatchState } from "../core/taste/types.js";
import { showIdTables } from "./mapping.js";
import { getSettings, patchSettings } from "./settings.js";

/** The configured media server (Plex or Jellyfin): watch progress for the taste model, and connecting one. */

type MediaConn = Settings["media"];

export interface Library {
  id: string;
  title: string;
}

/** Show libraries on the configured (or given) media server. */
export async function listLibraries(conn: MediaConn = getSettings().media): Promise<Library[]> {
  if (conn.type === "plex") return plexLibraries(conn);
  if (conn.type === "jellyfin") return jellyfinLibraries(conn);
  return [];
}

export const listJellyfinUsers = (conn: MediaConn) => jellyfinUsers(conn);

export async function testMediaServer(conn: MediaConn) {
  if (conn.type === "plex") return plexInfo(conn);
  if (conn.type === "jellyfin") return jellyfinInfo(conn);
  throw fail("No media server selected", 400);
}

/** How far the user got through each show, by TVDB id. Empty when no media server is set up. */
export async function watchStates(): Promise<Map<number, WatchState>> {
  const conn = getSettings().media;
  if (conn.type === "none" || !conn.url || !conn.token) return new Map();
  const libs = conn.libraryIds.length ? conn.libraryIds : (await listLibraries(conn)).map((l) => l.id);
  if (conn.type === "plex") return plexWatchStates(conn, libs, await showIdTables());
  if (conn.type === "jellyfin") return jellyfinWatchStates(conn, libs, await showIdTables());
  return new Map();
}

// --- "Sign in with Plex": the account token stays on the server; the browser only ever sees server names and URLs.

const pins = new Map<number, { token: string | null; at: number }>();
const PIN_TTL = 15 * 60_000;
const prunePins = () => {
  for (const [k, v] of pins) if (Date.now() - v.at > PIN_TTL) pins.delete(k);
};

export async function startPlexSignIn() {
  prunePins();
  const pin = await plexCreatePin(getSettings().plexClientId);
  pins.set(pin.id, { token: null, at: Date.now() });
  return pin;
}

/** Polled by the browser until the user approved the sign-in; then lists their servers (without tokens). */
export async function checkPlexSignIn(pinId: number) {
  const p = pins.get(pinId);
  if (!p || Date.now() - p.at > PIN_TTL) throw fail("Sign-in expired, start again", 410);
  p.token ??= await plexCheckPin(getSettings().plexClientId, pinId);
  if (!p.token) return { done: false };
  const servers = await plexServers(getSettings().plexClientId, p.token);
  return { done: true, servers: servers.map(({ accessToken: _t, ...s }) => s) };
}

/** Connects one of the signed-in account's servers, at one of its own addresses. */
export async function choosePlexServer(pinId: number, serverId: unknown, address: string) {
  const p = pins.get(pinId);
  if (!p?.token) throw fail("Sign in with Plex first", 410);
  const server = (await plexServers(getSettings().plexClientId, p.token)).find((s) => s.id === serverId);
  if (!server) throw fail("Server not found on your Plex account", 400);
  const url = address.replace(/\/+$/, "");
  if (!server.urls.includes(url)) throw fail("Pick one of the server's own addresses", 400);
  const conn = { ...getSettings().media, type: "plex" as const, url, token: server.accessToken };
  const info = await testMediaServer(conn);
  patchSettings((s) => ({ ...s, media: { ...s.media, type: "plex", url, token: server.accessToken } }));
  pins.delete(pinId);
  return { ...info, libraries: await listLibraries(conn).catch(() => []) };
}
