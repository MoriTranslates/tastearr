/**
 * Runs the test suite with every temporary folder inside one throwaway directory, wiped before and after. Each test
 * file makes its own scratch config folder (database, mapping list), so without this repeated runs would pile them up
 * on the system drive. Always run tests through `npm test`, never `node --test` directly.
 *
 *   npm test                   all tests
 *   npm test -- <files>        just those files
 *   npm run test:coverage      all tests plus a line-coverage table per layer; fails below the floors in FLOORS
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Minimum line coverage (%) per server layer, checked by `npm run test:coverage`. Raise these as coverage grows. */
const FLOORS = { "server/core": 90, "server/adapters": 85, "server/data": 95, "server/http": 75, "server/services": 75, server: 85 };

// One folder per run, so two runs at once (CI shards, several worktrees) never wipe each other's files.
const dir = path.join(os.tmpdir(), `tastearr-tests-${process.pid}`);
const wipe = () => fs.rmSync(dir, { recursive: true, force: true });
wipe();
fs.mkdirSync(dir, { recursive: true });

const args = process.argv.slice(2);
const coverage = args.includes("--coverage");
const files = args.filter((a) => a !== "--coverage");
const lcov = path.join(dir, "lcov.info");
const nodeArgs = ["--no-warnings", "--import", "tsx"];
if (coverage)
  nodeArgs.push(
    "--experimental-test-coverage",
    "--test-coverage-include=server/**",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcov}`,
  );
const r = spawnSync(process.execPath, [...nodeArgs, "--test", ...(files.length ? files : ["test/**/*.test.{ts,tsx}"])], {
  stdio: "inherit",
  env: {
    ...process.env,
    TSX_TSCONFIG_PATH: "test/tsconfig.json",
    TMPDIR: dir,
    TEMP: dir,
    TMP: dir,
    LOG_LEVEL: "silent",
    TASTEARR_TEST: "1",
  },
});

let status = r.status ?? 1;
if (coverage) {
  const covered = fs.existsSync(lcov) && report(fs.readFileSync(lcov, "utf8"));
  if (!covered && status === 0) status = 1;
}
wipe();
process.exit(status);

/** Prints lines covered per layer and returns false when any layer is under its floor. */
function report(text) {
  const totals = new Map();
  const add = (key, found, hit) => {
    const t = totals.get(key) ?? { found: 0, hit: 0 };
    t.found += found;
    t.hit += hit;
    totals.set(key, t);
  };
  for (const rec of text.split("end_of_record")) {
    const file = /^SF:(.+)$/m.exec(rec)?.[1]?.replaceAll("\\", "/");
    if (!file) continue;
    const rel = file.slice(file.lastIndexOf("/server/") + 1);
    const found = Number(/^LF:(\d+)/m.exec(rec)?.[1] ?? 0);
    const hit = Number(/^LH:(\d+)/m.exec(rec)?.[1] ?? 0);
    const layer = rel.split("/").slice(0, 2).join("/");
    add(layer.endsWith(".ts") ? "server (top level)" : layer, found, hit);
    add("server", found, hit);
  }
  let ok = true;
  console.log("\nLine coverage by layer");
  for (const [key, t] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = t.found ? (100 * t.hit) / t.found : 100;
    const floor = FLOORS[key];
    const bad = floor !== undefined && pct < floor;
    if (bad) ok = false;
    const note = floor === undefined ? "" : `  floor ${floor}%${bad ? "  FAILED" : ""}`;
    console.log(`  ${key.padEnd(22)} ${pct.toFixed(1).padStart(5)}%  (${t.hit}/${t.found})${note}`);
  }
  return ok;
}
