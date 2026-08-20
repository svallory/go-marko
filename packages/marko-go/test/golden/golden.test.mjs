import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateProject } from "../../src/project.mjs";

/**
 * Golden-file conformance suite (architecture-guidance.md item 3).
 *
 * Before this suite, the only checks on generated Go were substring
 * `toContain` assertions -- nothing byte-compared full output, so a change
 * that subtly reshuffled or reformatted a template's Go went undetected as
 * long as the substrings under test still matched. This suite instead
 * BYTE-COMPARES every file `generateProject` emits for `fixtures/` against a
 * committed golden under `goldens/`, and asserts the FILE SET matches
 * exactly (an extra or missing output fails too).
 *
 * `fixtures/` is a self-contained fake project (its own go.mod, tsconfig,
 * package.json, and an npm tag package under node_modules/) covering the
 * supported template surface with one construct per file, so a golden diff
 * localizes to exactly the construct that regressed.
 *
 * Regenerate goldens after an intentional output change:
 *
 *   UPDATE_GOLDENS=1 bun test test/golden/golden.test.mjs
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const GOLDENS = path.join(HERE, "goldens");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

/**
 * Recursively list files under `dir`, as slash-joined paths relative to
 * `dir` -- excluding `go.mod`, which isn't a generated golden. It exists
 * at the goldens/ root purely so `go build ./...`/`go vet ./...` run from
 * the repo root treat this tree as its own module (matching
 * fixtures/go.mod) instead of erroring on package paths that don't exist
 * under the real module.
 */
function listFiles(dir) {
  const out = [];
  walk(dir, "");
  return out.sort();

  function walk(abs, rel) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (rel === "" && entry.name === "go.mod") continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else out.push(childRel);
    }
  }
}

/**
 * Minimal unified diff between two strings, line by line. Not a full LCS
 * diff -- good enough to show a human where two golden files first and last
 * disagree, which is what matters for localizing a codegen regression.
 */
function unifiedDiff(expected, actual, label) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const lines = [`--- golden/${label}`, `+++ generated/${label}`];
  const max = Math.max(a.length, b.length);
  let mismatches = 0;
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    mismatches++;
    if (mismatches > 40) {
      lines.push("... (further differences truncated)");
      break;
    }
    if (a[i] !== undefined) lines.push(`-${i + 1}: ${a[i]}`);
    if (b[i] !== undefined) lines.push(`+${i + 1}: ${b[i]}`);
  }
  return lines.join("\n");
}

describe("golden-file conformance", () => {
  test("generateProject(fixtures/ui) matches the committed goldens byte-for-byte", async () => {
    const uiDir = path.join(FIXTURES, "ui");
    const { goFiles, diagnostics } = await generateProject(uiDir, {
      write: false,
      bestEffort: true,
    });

    expect(diagnostics.map((d) => `${d.markoPath}: ${d.error.message}`)).toEqual([]);

    const generated = new Map(
      goFiles.map((f) => [path.relative(FIXTURES, f.outPath).split(path.sep).join("/"), f.code]),
    );

    if (UPDATE) {
      // Regenerate goldens in place: remove stale files first so a fixture
      // that stopped producing an output doesn't leave an orphaned golden.
      // go.mod is preserved (rewritten verbatim) -- it's infrastructure
      // (see listFiles' comment), not a generated golden.
      const goModPath = path.join(GOLDENS, "go.mod");
      const goMod = fs.readFileSync(goModPath, "utf8");
      fs.rmSync(GOLDENS, { recursive: true, force: true });
      fs.mkdirSync(GOLDENS, { recursive: true });
      fs.writeFileSync(goModPath, goMod);
      for (const [rel, code] of generated) {
        const dest = path.join(GOLDENS, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, code);
      }
      console.log(`UPDATE_GOLDENS=1: wrote ${generated.size} golden file(s) to ${GOLDENS}`);
      return;
    }

    // File-set equality first: a missing or extra output is a clearer
    // failure than a diff against "file not found".
    const goldenFiles = listFiles(GOLDENS);
    const generatedFiles = [...generated.keys()].sort();
    expect(generatedFiles).toEqual(goldenFiles);

    for (const rel of goldenFiles) {
      const golden = fs.readFileSync(path.join(GOLDENS, rel), "utf8");
      const actual = generated.get(rel);
      if (golden !== actual) {
        throw new Error(
          `golden mismatch for ${rel}\n\n${unifiedDiff(golden, actual ?? "", rel)}`,
        );
      }
    }
  });

  test("every golden file is tab-indented Go ending in a newline", () => {
    for (const rel of listFiles(GOLDENS)) {
      const code = fs.readFileSync(path.join(GOLDENS, rel), "utf8");
      expect(code.endsWith("\n")).toBe(true);
      const badIndent = code
        .split("\n")
        .find((line) => /^ +\S/.test(line) && !line.trimStart().startsWith("*"));
      expect(badIndent).toBeUndefined();
    }
  });
});
