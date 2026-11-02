/**
 * Runs the test suite with every temporary folder inside one throwaway directory, wiped before and after. Each test
 * file makes its own scratch config folder (database, mapping list), so without this repeated runs would pile them up
 * on the system drive. Always run tests through `npm test`, never `node --test` directly.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One folder per run, so two runs at once (CI shards, several worktrees) never wipe each other's files.
const dir = path.join(os.tmpdir(), `tastearr-tests-${process.pid}`);
const wipe = () => fs.rmSync(dir, { recursive: true, force: true });
wipe();
fs.mkdirSync(dir, { recursive: true });
const files = process.argv.slice(2);
const r = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "--test", ...(files.length ? files : ["test/**/*.test.ts"])], {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, LOG_LEVEL: "silent", TASTEARR_TEST: "1" },
});
wipe();
process.exit(r.status ?? 1);
