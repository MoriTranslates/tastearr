import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * Finds Sonarr/Radarr API keys and the Plex token from a read-only mount of the host's appdata folder
 * (default /appdata), and container addresses from an optional read-only Docker socket mount.
 */
const APPDATA = process.env.TASTEARR_APPDATA ?? "/appdata";
const DOCKER_SOCK = process.env.TASTEARR_DOCKER_SOCK ?? "/var/run/docker.sock";

export interface Found {
  app: "sonarr" | "radarr" | "plex";
  folder: string;
  apiKey: string;
  port: number;
  urlBase: string;
  /** Best guess at a reachable URL, when the Docker socket is available. */
  url: string | null;
}

function tag(xml: string, name: string) {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";
}

function findFile(dir: string, rel: string[], depth = 2): string | null {
  for (const r of rel) {
    const p = path.join(dir, r);
    if (fs.existsSync(p)) return p;
  }
  if (depth === 0) return null;
  for (const e of safeReaddir(dir)) {
    if (!e.isDirectory()) continue;
    const hit = findFile(path.join(dir, e.name), rel, depth - 1);
    if (hit) return hit;
  }
  return null;
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

function guessUrl(containers: Container[], app: string, folder: string, port: number, urlBase: string, hostIp: string | null) {
  const key = folder.toLowerCase();
  const c = containers.find((x) => x.Names.some((n) => n.toLowerCase().includes(key) || key.includes(n.replace(/^\//, "").toLowerCase()))) ??
    containers.find((x) => x.Image.toLowerCase().includes(app));
  if (!c) return null;
  const base = urlBase ? `/${urlBase.replace(/^\/+|\/+$/g, "")}` : "";
  const published = c.Ports.find((p) => p.PrivatePort === port && p.PublicPort);
  if (published && hostIp) return `http://${hostIp}:${published.PublicPort}${base}`;
  const ip = Object.values(c.NetworkSettings.Networks).map((n) => n.IPAddress).find(Boolean);
  return ip ? `http://${ip}:${port}${base}` : null;
}

export async function discover(): Promise<{ appdata: boolean; docker: boolean; found: Found[] }> {
  const appdata = fs.existsSync(APPDATA);
  const containers = await dockerContainers();
  const hostIp = process.env.TASTEARR_HOST_IP ?? null;
  const found: Found[] = [];
  for (const e of appdata ? safeReaddir(APPDATA) : []) {
    if (!e.isDirectory()) continue;
    const name = e.name.toLowerCase();
    const dir = path.join(APPDATA, e.name);
    for (const app of ["sonarr", "radarr"] as const) {
      if (!name.includes(app)) continue;
      const cfg = findFile(dir, ["config.xml"], 1);
      if (!cfg) continue;
      const xml = fs.readFileSync(cfg, "utf8");
      const apiKey = tag(xml, "ApiKey");
      if (!apiKey) continue;
      const port = Number(tag(xml, "Port")) || (app === "sonarr" ? 8989 : 7878);
      const urlBase = tag(xml, "UrlBase");
      found.push({ app, folder: e.name, apiKey, port, urlBase, url: guessUrl(containers, app, e.name, port, urlBase, hostIp) });
    }
    if (name.includes("plex")) {
      const prefs = findFile(dir, ["Library/Application Support/Plex Media Server/Preferences.xml", "Preferences.xml"], 3);
      if (!prefs) continue;
      const token = fs.readFileSync(prefs, "utf8").match(/PlexOnlineToken="([^"]+)"/)?.[1];
      if (token) found.push({ app: "plex", folder: e.name, apiKey: token, port: 32400, urlBase: "", url: guessUrl(containers, "plex", e.name, 32400, "", hostIp) });
    }
  }
  return { appdata, docker: containers.length > 0, found };
}
