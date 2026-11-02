import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Process configuration from the environment, read once at startup. */

// UMASK like the linuxserver images (e.g. 002 so a shared group can read the config folder).
if (process.env.UMASK && /^[0-7]{3,4}$/.test(process.env.UMASK)) process.umask(parseInt(process.env.UMASK, 8));

export const CONFIG_DIR = process.env.TASTEARR_CONFIG ?? "/config";
export const PORT = Number(process.env.PORT ?? 8383);
/** Read-only mounts used to find Sonarr/Radarr (Settings -> Connections -> Detect). */
export const APPDATA = process.env.TASTEARR_APPDATA ?? "/appdata";
export const DOCKER_SOCK = process.env.TASTEARR_DOCKER_SOCK ?? "/var/run/docker.sock";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The built web UI: dist/web next to dist/server. */
export const WEB_DIR = path.resolve(HERE, "../web");

function findPackageJson() {
  for (let dir = HERE; ; dir = path.dirname(dir)) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) return p;
    if (path.dirname(dir) === dir) throw new Error("package.json not found");
  }
}
export const VERSION = JSON.parse(fs.readFileSync(findPackageJson(), "utf8")).version as string;
