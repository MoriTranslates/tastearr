import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { patchSettings } from "./settings.js";

/**
 * Finds Sonarr (and Radarr, for later) from a read-only mount of their config folders, and container addresses
 * from an optional read-only Docker socket. API keys never leave the server: the browser gets an id and picks
 * one, and the key is copied into settings here. Plex is connected with "Sign in with Plex" instead of reading
 * its account token from disk.
 */
const APPDATA = process.env.TASTEARR_APPDATA ?? "/appdata";
const DOCKER_SOCK = process.env.TASTEARR_DOCKER_SOCK ?? "/var/run/docker.sock";

interface Found {
  id: string;
  app: "sonarr" | "radarr";
  folder: string;
  apiKey: string;
  port: number;
  urlBase: string;
  url: string | null;
}

function tag(xml: string, name: string) {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";
}

function safeReaddir(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

interface Container { Names: string[]; Image: string; Ports: { PrivatePort: number; PublicPort?: number }[]; NetworkSettings: { Networks: Record<string, { IPAddress: string }> } }

function dockerContainers(): Promise<Container[]> {
  if (!fs.existsSync(DOCKER_SOCK)) return Promise.resolve([]);
  return new Promise((resolve) => {
    const req = http.get({ socketPath: DOCKER_SOCK, path: "/containers/json", timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => req.destroy());
  });
}

function guessUrl(containers: Container[], app: string, folder: string, port: number, urlBase: string) {
  const key = folder.toLowerCase();
  const c =
    containers.find((x) => x.Names.some((n) => n.replace(/^\//, "").toLowerCase() === key)) ??
    containers.find((x) => x.Names.some((n) => n.toLowerCase().includes(app))) ??
    containers.find((x) => x.Image.toLowerCase().includes(app));
  if (!c) return null;
  const base = urlBase ? `/${urlBase.replace(/^\/+|\/+$/g, "")}` : "";
  const hostIp = process.env.TASTEARR_HOST_IP;
  const published = c.Ports.find((p) => p.PrivatePort === port && p.PublicPort);
  if (published && hostIp) return `http://${hostIp}:${published.PublicPort}${base}`;
  const ip = Object.values(c.NetworkSettings.Networks).map((n) => n.IPAddress).find(Boolean);
  return ip ? `http://${ip}:${port}${base}` : null;
}

/** Config folders to inspect: /appdata itself (if a single app's folder is mounted there) and its subfolders. */
function candidates() {
  if (!fs.existsSync(APPDATA)) return [];
  return [{ name: path.basename(APPDATA), dir: APPDATA }, ...safeReaddir(APPDATA).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, dir: path.join(APPDATA, e.name) }))];
}

async function scan(): Promise<{ appdata: boolean; docker: boolean; found: Found[] }> {
  const containers = await dockerContainers();
  const found: Found[] = [];
  for (const { name, dir } of candidates()) {
    const cfg = path.join(dir, "config.xml");
    if (!fs.existsSync(cfg)) continue;
    const xml = fs.readFileSync(cfg, "utf8");
    const instance = tag(xml, "InstanceName").toLowerCase();
    const app = instance.includes("radarr") || name.toLowerCase().includes("radarr") ? "radarr" : instance.includes("sonarr") || name.toLowerCase().includes("sonarr") ? "sonarr" : null;
    const apiKey = tag(xml, "ApiKey");
    if (!app || !apiKey) continue;
    const port = Number(tag(xml, "Port")) || (app === "sonarr" ? 8989 : 7878);
    const urlBase = tag(xml, "UrlBase");
    const id = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 12);
    found.push({ id, app, folder: name, apiKey, port, urlBase, url: guessUrl(containers, app, name, port, urlBase) });
  }
  return { appdata: fs.existsSync(APPDATA), docker: containers.length > 0, found };
}

/** What the browser sees: no keys. */
export async function discover() {
  const r = await scan();
  return { ...r, found: r.found.map(({ apiKey: _k, ...f }) => ({ ...f, usable: f.app === "sonarr" || f.app === "radarr" })) };
}

/** A LAN address: private IPv4, loopback, a single-label Docker/mDNS name or *.local. */
export function isPrivateHost(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) && /^[\d.]+$/.test(h)) return true;
  if (h === "localhost" || h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  return /^[a-z0-9-]+$/.test(h) || h.endsWith(".local");
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
  if (!/^https?:$/.test(u.protocol)) throw new Error("URL must start with http:// or https://");
  const detected = f.url?.replace(/\/+$/, "") === clean;
  if (!detected) {
    if (!loggedIn) throw new Error("Log in with your password to use a different address, or paste the API key yourself");
    if (!isPrivateHost(u.hostname)) throw new Error("The detected key is only sent to an address on your home network. For anything else, paste the API key yourself.");
  }
  patchSettings((s) => ({ ...s, [f.app]: { ...s[f.app as "sonarr" | "radarr"], url: clean, apiKey: f.apiKey } }));
  return { ok: true, app: f.app };
}
