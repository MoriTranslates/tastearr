import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Source and Markdown files may not contain control characters other than tab, LF and CR. A regex with an invisible
 * backspace byte once passed review for days because it failed silently; this makes such a byte fail the build.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
/** Folders scanned recursively; the repository root itself is scanned without recursing. */
const DIRS = ["server", "web", "test", "scripts", "docs", ".github"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".yaml", ".yml", ".json", ".css", ".html"]);
const SKIP = new Set(["node_modules", "dist", "fixtures"]);
// Every C0 control character except tab (0x09), LF (0x0A) and CR (0x0D), plus DEL (0x7F).
const BAD = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

function filesIn(dir: string, recurse: boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recurse && !SKIP.has(e.name)) out.push(...filesIn(p, true));
    } else if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

/** Every control character found under `root`, as "file:line:column (0xNN)". */
export function findControlBytes(root: string): string[] {
  const files = [...filesIn(root, false), ...DIRS.flatMap((d) => filesIn(path.join(root, d), true))];
  const found: string[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = BAD.exec(line);
      if (m) found.push(`${path.relative(root, f)}:${i + 1}:${m.index + 1} (0x${m[0].charCodeAt(0).toString(16).padStart(2, "0")})`);
    });
  }
  return found;
}

test("no source or Markdown file contains a control character other than tab, LF or CR", () => {
  assert.deepEqual(findControlBytes(ROOT), []);
});

test("the check finds a backspace byte injected into a copy of a source file, and skips node_modules, dist and fixtures", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-"));
  try {
    const text = fs.readFileSync(path.join(ROOT, "server", "core", "errors.ts"), "utf8");
    fs.mkdirSync(path.join(tmp, "server", "core"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "server", "core", "errors.ts"), text);
    assert.deepEqual(findControlBytes(tmp), [], "the clean copy passes");
    const bad = text.replace("statusCode = 400", `statusCode = 4${String.fromCharCode(8)}00`);
    assert.notEqual(bad, text, "the byte was injected");
    fs.writeFileSync(path.join(tmp, "server", "core", "errors.ts"), bad);
    for (const skipped of ["node_modules", "dist", "fixtures"]) {
      fs.mkdirSync(path.join(tmp, "test", skipped), { recursive: true });
      fs.writeFileSync(path.join(tmp, "test", skipped, "x.ts"), String.fromCharCode(8));
    }
    fs.writeFileSync(path.join(tmp, "notes.md"), `ok${String.fromCharCode(27)}`);
    const found = findControlBytes(tmp);
    assert.equal(found.length, 2, found.join(", "));
    assert.match(found.join(" "), /server[\\/]core[\\/]errors\.ts:\d+:\d+ \(0x08\)/);
    assert.match(found.join(" "), /notes\.md:1:3 \(0x1b\)/, "root-level Markdown is scanned too");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
