import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { APPDATA, DOCKER_SOCK } from "../config.js";

/**
 * Finds Sonarr and Radarr from a read-only mount of their config folders (config.xml has the API key, port and URL
 * base), and their container addresses from an optional read-only Docker socket.
 */

export interface Found {
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

interface Container {
  Names: string[];
  Image: string;
  Ports: { PrivatePort: number; PublicPort?: number }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
}

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
  const ip = Object.values(c.NetworkSettings.Networks)
    .map((n) => n.IPAddress)
    .find(Boolean);
  return ip ? `http://${ip}:${port}${base}` : null;
}

/** Config folders to inspect: /appdata itself (if a single app's folder is mounted there) and its subfolders. */
function candidates() {
  if (!fs.existsSync(APPDATA)) return [];
  return [
    { name: path.basename(APPDATA), dir: APPDATA },
    ...safeReaddir(APPDATA)
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, dir: path.join(APPDATA, e.name) })),
  ];
}

export async function scan(): Promise<{ appdata: boolean; docker: boolean; found: Found[] }> {
  const containers = await dockerContainers();
  const found: Found[] = [];
  for (const { name, dir } of candidates()) {
    const cfg = path.join(dir, "config.xml");
    if (!fs.existsSync(cfg)) continue;
    const xml = fs.readFileSync(cfg, "utf8");
    const instance = tag(xml, "InstanceName").toLowerCase();
    const app =
      instance.includes("radarr") || name.toLowerCase().includes("radarr")
        ? "radarr"
        : instance.includes("sonarr") || name.toLowerCase().includes("sonarr")
          ? "sonarr"
          : null;
    const apiKey = tag(xml, "ApiKey");
    if (!app || !apiKey) continue;
    const port = Number(tag(xml, "Port")) || (app === "sonarr" ? 8989 : 7878);
    const urlBase = tag(xml, "UrlBase");
    const id = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 12);
    found.push({ id, app, folder: name, apiKey, port, urlBase, url: guessUrl(containers, app, name, port, urlBase) });
  }
  return { appdata: fs.existsSync(APPDATA), docker: containers.length > 0, found };
}
