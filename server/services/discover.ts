import { scan } from "../adapters/discovery.js";
import { isPrivateHost } from "../core/network.js";
import { checkOutbound } from "../core/outbound.js";
import { patchSettings } from "./settings.js";

/**
 * Connect Sonarr/Radarr found on disk. API keys never leave the server: the browser gets an id and picks one, and the
 * key is copied into settings here. Plex is connected with "Sign in with Plex" instead of reading its token from disk.
 */

/** What the browser sees: no keys. */
export async function discover() {
  const r = await scan();
  return { ...r, found: r.found.map(({ apiKey: _k, ...f }) => ({ ...f, usable: f.app === "sonarr" || f.app === "radarr" })) };
}

/**
 * Copies a discovered Sonarr/Radarr key into settings. The key read from disk only ever goes to the address we
 * detected, or (for a logged-in user) to a LAN address on the app's own port, never to an arbitrary URL.
 */
export async function useDiscovered(id: string, url: string, loggedIn: boolean) {
  const f = (await scan()).found.find((x) => x.id === id);
  if (!f) throw new Error("That app is no longer detected");
  if (f.app !== "sonarr" && f.app !== "radarr") throw new Error("Only Sonarr and Radarr can be connected this way");
  const clean = url.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(clean);
  } catch {
    throw new Error("That isn't a valid address");
  }
  checkOutbound(clean);
  const detected = f.url?.replace(/\/+$/, "") === clean;
  if (!detected) {
    if (!loggedIn) throw new Error("Log in with your password to use a different address, or paste the API key yourself");
    if (!isPrivateHost(u.hostname))
      throw new Error("The detected key is only sent to an address on your home network. For anything else, paste the API key yourself.");
  }
  patchSettings((s) => ({ ...s, [f.app]: { ...s[f.app as "sonarr" | "radarr"], url: clean, apiKey: f.apiKey } }));
  return { ok: true, app: f.app };
}
