/**
 * Imported first by every test file (each file runs in its own process): gives it a private config folder (database,
 * mapping list) inside the runner's temp folder, and makes any un-mocked network call fail loudly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TASTEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
process.env.LOG_LEVEL ??= "silent";
delete process.env.TRUST_PROXY;
delete process.env.TASTEARR_LOCAL_NETWORKS;
delete process.env.TASTEARR_ALLOWED_HOSTS;
process.env.TASTEARR_APPDATA = path.join(process.env.TASTEARR_CONFIG, "no-appdata");
process.env.TASTEARR_DOCKER_SOCK = path.join(process.env.TASTEARR_CONFIG, "no-docker.sock");

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`Unexpected network call in a test: ${String(input instanceof Request ? input.url : input)}`);
}) as typeof fetch;
