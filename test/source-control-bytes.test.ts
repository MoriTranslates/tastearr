import "./env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Source and Markdown files may not contain invisible or invalid characters. A regex with an invisible backspace byte
 * once passed review for days because it failed silently, and an editor or shell can turn an escape typed as text into
 * the real character. Every code point here is written as a number, so this file can't carry what it looks for.
 * (Same rules as AnimeArr's test/source-chars.test.ts, plus DEL.)
 */

const ROOT = path.resolve(import.meta.dirname, "..");
/** Folders scanned recursively; the repository root itself is scanned without recursing. */
const DIRS = ["server", "web", "test", "scripts", "docs", ".github"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".md", ".yaml", ".yml", ".json", ".css", ".html"]);
const SKIP = new Set(["node_modules", "dist", "fixtures"]);

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** Whether code unit `cp` at `offset` (in a text, not part of a surrogate pair) is refused. */
function refused(cp: number, offset: number) {
  return (
    (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || // C0 controls other than tab, LF, CR
    cp === 0x7f || // DEL
    (cp >= 0xdc00 && cp <= 0xdfff) || // a low surrogate with no high one before it
    cp === 0xfffe ||
    cp === 0xffff ||
    cp === 0x2028 || // line separator
    cp === 0x2029 || // paragraph separator
    (cp === 0xfeff && offset !== 0) || // zero-width no-break space: allowed only as a BOM at the very start
    cp === 0x200b || // zero-width space
    cp === 0xfffd // replacement character: what a lone surrogate or a broken encoding becomes in a UTF-8 file
  );
}

/** The refused characters in `text`, as "line:column (U+XXXX)" (a lone high surrogate as "lone surrogate U+XXXX"). */
export function invisibleChars(text: string): string[] {
  const out: string[] = [];
  let line = 1;
  let col = 1;
  for (let i = 0; i < text.length; i++, col++) {
    const cp = text.charCodeAt(i);
    if (cp === 0x0a) {
      line++;
      col = 0;
      continue;
    }
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // a surrogate pair (an emoji) is fine
        continue;
      }
      out.push(`${line}:${col} (lone surrogate ${hex(cp)})`);
      continue;
    }
    if (refused(cp, i)) out.push(`${line}:${col} (${hex(cp)})`);
  }
  return out;
}

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

/** Every refused character found under `root`, as "file:line:column (U+XXXX)". */
export function findControlBytes(root: string): string[] {
  const files = [...filesIn(root, false), ...DIRS.flatMap((d) => filesIn(path.join(root, d), true))];
  return files.flatMap((f) => invisibleChars(fs.readFileSync(f, "utf8")).map((x) => `${path.relative(root, f)}:${x}`));
}

test("no source or Markdown file contains an invisible or invalid character", () => {
  assert.deepEqual(findControlBytes(ROOT), []);
});

test("allowed: a BOM at the very start, tab, CR/LF, CJK text and emoji (a surrogate pair)", () => {
  const ok = String.fromCharCode(0xfeff) + "a\tb\r\nc " + String.fromCodePoint(0x846c, 0x9001, 0x1f389) + "\n";
  assert.deepEqual(invisibleChars(ok), []);
  assert.match(invisibleChars("a" + String.fromCharCode(0xd800) + "b")[0], /lone surrogate U\+D800/, "named in memory");
});

test("each invisible or invalid character injected into a temp copy of a source file is found", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chars-"));
  try {
    const text = fs.readFileSync(path.join(ROOT, "server", "core", "errors.ts"), "utf8");
    const at = text.indexOf("export");
    fs.mkdirSync(path.join(tmp, "server", "core"), { recursive: true });
    const missed: string[] = [];
    // C0 controls, DEL, U+FFFE, U+FFFF, line and paragraph separators, a BOM not at the start, zero-width space,
    // the replacement character, and lone surrogate halves (stored on disk as U+FFFD).
    for (const cp of [0x00, 0x08, 0x0b, 0x1b, 0x7f, 0xfffe, 0xffff, 0x2028, 0x2029, 0xfeff, 0x200b, 0xfffd, 0xd800, 0xdc00]) {
      fs.writeFileSync(path.join(tmp, "server", "core", "errors.ts"), text.slice(0, at) + String.fromCharCode(cp) + text.slice(at));
      const found = findControlBytes(tmp);
      if (found.length !== 1) missed.push(`0x${cp.toString(16)} (${found.length} found)`);
    }
    assert.deepEqual(missed, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
    assert.match(found.join(" "), /server[\\/]core[\\/]errors\.ts:\d+:\d+ \(U\+0008\)/);
    assert.match(found.join(" "), /notes\.md:1:3 \(U\+001B\)/, "root-level Markdown is scanned too");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
