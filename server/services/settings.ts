import type { PublicSettings } from "../../shared/api.js";
import { hashPassword } from "../core/secrets.js";
import { applyUpdate, cleanGenrePrefs, loadSettings, rand, toPublicSettings, type Settings } from "../core/settings.js";
import { getValue, setValue } from "../data/kv.js";

/** The settings document, read once and cached; every write goes through here so the cache stays current. */

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  const row = getValue("settings");
  const { settings, changed } = loadSettings(row ? (JSON.parse(row) as Record<string, unknown>) : {});
  if (changed) write(settings);
  cache = settings;
  return settings;
}

function write(s: Settings) {
  setValue("settings", JSON.stringify(s));
  cache = s;
}

/** Settings as sent to the browser: every secret masked, hashes and signing keys removed. */
export function publicSettings(): PublicSettings {
  return toPublicSettings(getSettings());
}

/** Applies an untrusted partial update from the browser. Masked secrets mean "unchanged". */
export function updateSettings(patch: unknown) {
  const next = applyUpdate(getSettings(), patch);
  write(next);
  return next;
}

export function setBypassLocal(on: boolean) {
  write({ ...getSettings(), auth: { ...getSettings().auth, bypassLocal: on } });
}

/** Internal update that skips sanitising (server-side values such as an auto-detected key or a Plex token). */
export function patchSettings(fn: (s: Settings) => Settings) {
  write(fn(structuredClone(getSettings())));
}

export function setGenrePrefs(prefs: unknown) {
  write({ ...getSettings(), genrePrefs: cleanGenrePrefs(prefs) });
}

export function regenerateKey(which: "apiKey" | "webhookKey") {
  const s = { ...getSettings(), [which]: rand(16) };
  write(s);
  return s[which];
}

export async function setAccount(username: string, password: string) {
  const hash = await hashPassword(password);
  const s = getSettings();
  // A new secret invalidates every existing session.
  write({ ...s, auth: { ...s.auth, username, passwordHash: hash }, secret: rand(32) });
}

export const sonarrConfigured = () => !!(getSettings().sonarr.url && getSettings().sonarr.apiKey);
export const radarrConfigured = () => !!(getSettings().radarr.url && getSettings().radarr.apiKey);
